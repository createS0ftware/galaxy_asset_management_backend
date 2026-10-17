import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { conflict, notFound, rejected } from '../lib/errors.js';
import { Kind, makePayload } from '../lib/payload.js';
import { TrailContract, type Resolution } from '../stellar/trail.js';
import { anchor } from './anchoring.js';
import { tripLocks } from './checkins.js';
import { getTripRow, getWaypoints, syncTrip } from './trips.js';

async function staffName(ctx: Ctx, staffId: number) {
  const s = await ctx.db.query.staffUsers.findFirst({ where: eq(schema.staffUsers.id, staffId) });
  return s?.name ?? `staff:${staffId}`;
}

const lastSeq = async (ctx: Ctx, tripId: string) => (await ctx.trail.trip(tripId))!;

/**
 * BR-07: every manual override is an anchored event carrying reason and staff name.
 * kinds: extend_window (also updates the window), reroute, pay_hold, pay_release, note.
 */
export async function logOverride(
  ctx: Ctx,
  tripId: string,
  staffId: number,
  input: { kind: 'extend_window' | 'reroute' | 'pay_hold' | 'pay_release' | 'note'; reason: string; wp?: number; windowEnd?: string },
) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (trip.status === 'closed') throw conflict('TRIP_CLOSED');
    if (input.kind === 'extend_window') {
      const wps = await getWaypoints(ctx, tripId);
      const w = wps[input.wp ?? trip.nextWp];
      if (!w || !input.windowEnd) throw rejected('BAD_OVERRIDE', 'extend_window needs wp and windowEnd');
      if (new Date(input.windowEnd) <= w.windowEnd) throw rejected('BAD_OVERRIDE', 'New window end must be later');
    }
    const payload = makePayload('override', {
      trip: tripId,
      kind: input.kind,
      wp: input.wp ?? trip.nextWp,
      window_end: input.windowEnd ?? null,
      reason: input.reason,
      staff: await staffName(ctx, staffId),
      t: new Date().toISOString(),
    });
    const res = await anchor(
      ctx,
      { assetId: trip.assetId, tripId, kind: Kind.OVERRIDE, wp: trip.nextWp, payload, actor: `staff:${staffId}` },
      async (hash) => {
        const tx = await ctx.trail.call('log_override', TrailContract.args.log_override(tripId, hash), { kind: 'record', signers: [ctx.admin] });
        return { tx, seq: (await lastSeq(ctx, tripId)).records.at(-1)!.seq };
      },
    );
    if (input.kind === 'extend_window') {
      await ctx.db
        .update(schema.waypoints)
        .set({ windowEnd: new Date(input.windowEnd!) })
        .where(and(eq(schema.waypoints.tripId, tripId), eq(schema.waypoints.idx, input.wp ?? trip.nextWp)));
    }
    return res.event;
  });
}

/** BR-07: ops records a check-in the driver couldn't make. Leg pay is released as normal. */
export async function forceCheckIn(ctx: Ctx, tripId: string, staffId: number, input: { wp: number; reason: string; lat?: number; lon?: number }) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    const wps = await getWaypoints(ctx, tripId);
    if (input.wp !== trip.nextWp) throw rejected('WRONG_WAYPOINT', `Next expected waypoint is ${trip.nextWp}`);
    const w = wps[input.wp]!;
    const name = await staffName(ctx, staffId);
    const payload = makePayload('forced_checkin', {
      trip: tripId,
      wp: input.wp,
      asset: trip.assetId,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      t: new Date().toISOString(),
    });
    const reason = makePayload('override', { trip: tripId, kind: 'force_checkin', wp: input.wp, reason: input.reason, staff: name });
    const last = wps.length - 1;
    const pay = input.wp === last ? 0n : BigInt(w.legPay);
    const res = await anchor(
      ctx,
      { assetId: trip.assetId, tripId, kind: Kind.FORCED_CHECKIN, wp: input.wp, payload, auxPayload: reason, amount: pay, actor: `staff:${staffId}` },
      async (hash, aux) => {
        const tx = await ctx.trail.call('force_check_in', TrailContract.args.force_check_in(tripId, input.wp, hash, aux!), ctx.signer.withAdmin(ctx.admin));
        const chain = await lastSeq(ctx, tripId);
        await syncTrip(ctx, tripId, chain, input.wp === last ? { arrivedAt: tx.ledgerTime } : {});
        return { tx, seq: chain.records.at(-1)!.seq };
      },
    );
    return res.event;
  });
}

/** BR-05 / dispute resolution: resume the trip or release (part of) the final pay. */
export async function resolveDispute(ctx: Ctx, tripId: string, staffId: number, input: { resolution: Resolution; reason: string }) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (trip.status !== 'disputed') throw conflict('NOT_DISPUTED');
    const payload = makePayload('resolve', {
      trip: tripId,
      resolution: input.resolution.kind,
      pay: input.resolution.kind === 'release' ? input.resolution.pay.toString() : null,
      reason: input.reason,
      staff: await staffName(ctx, staffId),
      t: new Date().toISOString(),
    });
    const res = await anchor(
      ctx,
      {
        assetId: trip.assetId,
        tripId,
        kind: Kind.RESOLVE,
        wp: trip.nextWp,
        payload,
        amount: input.resolution.kind === 'release' ? input.resolution.pay : 0n,
        actor: `staff:${staffId}`,
      },
      async (hash) => {
        const tx = await ctx.trail.call('resolve_dispute', TrailContract.args.resolve_dispute(tripId, input.resolution, hash), {
          kind: 'record',
          signers: [ctx.admin],
        });
        const chain = await lastSeq(ctx, tripId);
        await syncTrip(ctx, tripId, chain, chain.status === 'Delivered' ? { deliveredAt: tx.ledgerTime } : {});
        return { tx, seq: chain.records.at(-1)!.seq };
      },
    );
    return res.event;
  });
}

export async function cancelTrip(ctx: Ctx, tripId: string, staffId: number, reason: string) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    const payload = makePayload('cancel', { trip: tripId, reason, staff: await staffName(ctx, staffId), t: new Date().toISOString() });
    const res = await anchor(ctx, { assetId: trip.assetId, tripId, kind: Kind.CANCEL, wp: trip.nextWp, payload, actor: `staff:${staffId}` }, async (hash) => {
      const tx = await ctx.trail.call('cancel_trip', TrailContract.args.cancel_trip(tripId, hash), { kind: 'record', signers: [ctx.admin] });
      const chain = await lastSeq(ctx, tripId);
      await syncTrip(ctx, tripId, chain);
      return { tx, seq: chain.records.at(-1)!.seq };
    });
    return res.event;
  });
}

/** T10 / BR-10: return unused escrow to the treasury. */
export async function closeTrip(ctx: Ctx, tripId: string) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (!['delivered', 'cancelled'].includes(trip.status)) throw conflict('TRIP_NOT_FINISHED', `Trip is ${trip.status}`);
    const before = trip.escrow - trip.released;
    const tx = await ctx.trail.call('close_trip', TrailContract.args.close_trip(tripId), { kind: 'record', signers: [ctx.admin] });
    await syncTrip(ctx, tripId, (await ctx.trail.trip(tripId))!, { closedAt: tx.ledgerTime });
    return { txHash: tx.txHash, refunded: before };
  });
}

export async function getOverrideTarget(ctx: Ctx, tripId: string) {
  const t = await ctx.db.query.trips.findFirst({ where: eq(schema.trips.id, tripId) });
  if (!t) throw notFound('Trip');
  return t;
}
