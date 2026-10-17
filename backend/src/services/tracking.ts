import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { conflict, notFound, rejected, unauthorized } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { Kind, makePayload } from '../lib/payload.js';
import { TrailContract } from '../stellar/trail.js';
import { anchor } from './anchoring.js';
import { tripLocks } from './checkins.js';
import { checkOtp, sendOtp } from './otp.js';
import { receiverKey } from './receivers.js';
import { getWaypoints, syncTrip, tripView } from './trips.js';

async function byToken(ctx: Ctx, token: string) {
  const trip = await ctx.db.query.trips.findFirst({ where: eq(schema.trips.trackingToken, token) });
  if (!trip) throw notFound('Tracking link');
  const receiver = (await ctx.db.query.receivers.findFirst({ where: eq(schema.receivers.id, trip.receiverId) }))!;
  const asset = (await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, trip.assetId) }))!;
  return { trip, receiver, asset };
}

const BANNERS: Record<string, string> = {
  funded: 'Preparing for pickup',
  accepted: 'Driver assigned',
  in_transit: 'On the way',
  awaiting_signature: 'Arrived — please inspect and sign',
  disputed: 'Problem reported — final pay is on hold',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  closed: 'Delivered',
};

/** Journey 5.3: no login, no wallet. Verified waypoints (solid) and live estimate (dashed) kept apart. */
export async function trackingView(ctx: Ctx, token: string) {
  const { trip, receiver, asset } = await byToken(ctx, token);
  const v = await tripView(ctx, trip.id);
  const final = v.waypoints.at(-1)!;
  return {
    trip: trip.id,
    asset: { id: asset.id, name: asset.name },
    driverFirstName: v.driver?.name.split(' ')[0] ?? null,
    status: trip.status,
    banner: BANNERS[trip.status],
    verified: v.waypoints
      .filter((w) => w.verified)
      .map((w) => ({ idx: w.idx, name: w.name, type: w.type, ...w.verified, txShort: w.verified!.txHash?.slice(0, 4) + '…' + w.verified!.txHash?.slice(-4) })),
    next: v.waypoints.find((w) => w.state === 'next') ?? null,
    live: v.live,
    finalPay: final.legPay,
    signingReleasesPay: true,
    /** Sign or report a problem before this; after it the driver can claim the final pay. */
    signBy: v.deliveryDeadline,
    onChain: { contractId: ctx.trail.contractId, assetKey: asset.id, receiverAddress: receiver.publicKey },
  };
}

export async function sendSignOtp(ctx: Ctx, token: string) {
  const { trip, receiver } = await byToken(ctx, token);
  const code = await sendOtp(ctx, receiver.phone, `receiver:${trip.id}`, (c) => `Your code to sign for ${trip.id}: ${c}`);
  const sent = { sent: true, to: receiver.phone.replace(/.(?=.{3})/g, '•') };
  // Demo set-ups without an SMS provider (SHOW_OTP_IN_RESPONSE) get the code back.
  return ctx.config.SHOW_OTP_IN_RESPONSE ? { ...sent, devCode: code } : sent;
}

/**
 * Journey 5.3 stage 4 / T8: the receiver's custodial key (unlocked by OTP) and the platform
 * co-sign confirm_delivery with the hash of the inspection receipt. Releases the final pay.
 */
export async function signDelivery(ctx: Ctx, token: string, input: { code: string; tag: string; noDamage: boolean }) {
  const { trip, receiver, asset } = await byToken(ctx, token);
  return tripLocks.run(trip.id, async () => {
    if (trip.status !== 'awaiting_signature') throw conflict('NOT_AWAITING_SIGNATURE', `Trip is ${trip.status}`);
    if (!(await checkOtp(ctx, receiver.phone, `receiver:${trip.id}`, input.code))) throw unauthorized('Invalid or expired code');
    if (input.tag !== asset.tagId) throw rejected('TAG_MISMATCH', "Scanned tag doesn't match this delivery");
    if (!input.noDamage) throw rejected('DAMAGE_REPORTED', 'Use "Report a problem" instead of signing');
    const wps = await getWaypoints(ctx, trip.id);
    const last = wps.length - 1;
    const payload = makePayload('delivery', {
      trip: trip.id,
      asset: asset.id,
      wp: last,
      receiver: receiver.publicKey,
      checks: { tag_match: true, no_damage: true },
      t_sign: new Date().toISOString(),
    });
    const res = await anchor(
      ctx,
      { assetId: asset.id, tripId: trip.id, kind: Kind.DELIVERY, wp: last, payload, actor: `receiver:${receiver.id}` },
      async (hash) => {
        const args = TrailContract.args.confirm_delivery(trip.id, hash);
        const latest = await ctx.sub.latestLedger();
        const receiverEntry = await ctx.trail.sign(receiverKey(ctx, receiver), 'confirm_delivery', args, latest + 100);
        const platform = await ctx.signer.coSign('confirm_delivery', args, latest);
        const tx = await ctx.trail.call('confirm_delivery', args, { kind: 'entries', entries: [receiverEntry, platform] });
        const chain = (await ctx.trail.trip(trip.id))!;
        await syncTrip(ctx, trip.id, chain, { deliveredAt: tx.ledgerTime });
        const rec = chain.records.at(-1)!;
        await ctx.db.update(schema.custodyEvents).set({ amount: Number(rec.amount) }).where(eq(schema.custodyEvents.hash, hash.toString('hex')));
        return { tx, seq: rec.seq };
      },
    );
    return { event: res.event, txHash: res.tx.txHash, finalPay: fromStroops(BigInt(res.event.amount)) };
  });
}

/** Journey 5.3 stage 5: report damage/shortage. Photo evidence required; final pay is held. */
export async function reportProblem(ctx: Ctx, token: string, input: { code: string; notes: string; photos: string[] }) {
  const { trip, receiver, asset } = await byToken(ctx, token);
  return tripLocks.run(trip.id, async () => {
    if (!['funded', 'accepted', 'in_transit', 'awaiting_signature'].includes(trip.status)) throw conflict('CANNOT_REPORT', `Trip is ${trip.status}`);
    // Mirrors the contract: a late dispute must not block the driver's claim on the final leg.
    if (trip.status === 'awaiting_signature' && trip.deliveryDeadline && Date.now() > trip.deliveryDeadline.getTime()) {
      throw rejected('DEADLINE_PASSED', `Problems had to be reported by ${trip.deliveryDeadline.toISOString()}`);
    }
    if (!(await checkOtp(ctx, receiver.phone, `receiver:${trip.id}`, input.code))) throw unauthorized('Invalid or expired code');
    if (!input.photos.length) throw rejected('PHOTO_REQUIRED', 'Add at least one photo');
    const payload = makePayload('dispute', {
      trip: trip.id,
      asset: asset.id,
      by: receiver.publicKey,
      notes: input.notes,
      photos: input.photos,
      t: new Date().toISOString(),
    });
    const res = await anchor(
      ctx,
      { assetId: asset.id, tripId: trip.id, kind: Kind.DISPUTE, wp: trip.nextWp, payload, actor: `receiver:${receiver.id}` },
      async (hash) => {
        const args = TrailContract.args.report_problem(trip.id, receiver.publicKey, hash);
        const latest = await ctx.sub.latestLedger();
        const entry = await ctx.trail.sign(receiverKey(ctx, receiver), 'report_problem', args, latest + 100);
        const tx = await ctx.trail.call('report_problem', args, { kind: 'entries', entries: [entry] });
        const chain = (await ctx.trail.trip(trip.id))!;
        await syncTrip(ctx, trip.id, chain);
        return { tx, seq: chain.records.at(-1)!.seq };
      },
    );
    return { event: res.event, txHash: res.tx.txHash };
  });
}
