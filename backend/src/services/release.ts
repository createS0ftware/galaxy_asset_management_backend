import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { badRequest, conflict, forbidden, rejected } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { hashPayload, Kind, type ReleasePayload } from '../lib/payload.js';
import { TrailContract } from '../stellar/trail.js';
import { anchor } from './anchoring.js';
import { parseEntry, tripLocks } from './checkins.js';
import { getDriver, usdcBalance } from './drivers.js';
import { getTripRow, getWaypoints, syncTrip, type Trip } from './trips.js';

export interface FinalPayRequest {
  payload: ReleasePayload;
  /** Driver-signed Soroban auth entry for claim_final_pay(trip, sha256(payload)), base64 XDR. */
  authEntry: string;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Checks on the phone's release payload. Returns the device time. */
export function checkReleasePayload(p: ReleasePayload, c: { tripId: string; assetId: string; now: Date }): Date {
  if (p.trip !== c.tripId) throw rejected('TRIP_MISMATCH', 'Payload is for a different trip');
  if (p.asset !== c.assetId) throw rejected('ASSET_MISMATCH', 'Payload is for a different asset');
  const t = new Date(p.t_device);
  if (typeof p.t_device !== 'string' || !ISO_TIME.test(p.t_device) || Number.isNaN(t.getTime())) {
    throw rejected('BAD_PAYLOAD', 't_device must be an ISO timestamp');
  }
  if (t.getTime() > c.now.getTime() + 5 * 60_000) throw rejected('FUTURE_TIME', 'Device time is in the future');
  return t;
}

/** The final leg minus claimed advances (BR-06), as paid by claim_final_pay and confirm_delivery. */
export function finalPayAmount(trip: Pick<Trip, 'advanced'>, finalLegPay: number | bigint) {
  const deduction = BigInt(trip.advanced);
  return { payout: BigInt(finalLegPay) - deduction, deduction };
}

/** Awaiting signature and past the deadline set at dispatch (the contract requires ledger time > deadline). */
export const isClaimable = (trip: Pick<Trip, 'status' | 'deliveryDeadline'>, now = new Date()) =>
  trip.status === 'awaiting_signature' && trip.deliveryDeadline !== null && now.getTime() > trip.deliveryDeadline.getTime();

/** What the phone needs to build and sign claim_final_pay, shown while the trip awaits the receiver. */
export async function finalPayTemplate(ctx: Ctx, trip: Trip, now = new Date()) {
  const waypoints = await getWaypoints(ctx, trip.id);
  const { payout } = finalPayAmount(trip, waypoints.at(-1)!.legPay);
  return {
    contractId: ctx.trail.contractId,
    networkPassphrase: ctx.sub.passphrase,
    latestLedger: await ctx.sub.latestLedger(),
    ledgerSeconds: 5,
    deadline: trip.deliveryDeadline?.toISOString() ?? null,
    claimable: isClaimable(trip, now),
    amount: fromStroops(payout),
  };
}

/**
 * §4.6: nobody signed or reported a problem by the delivery deadline, so the driver claims the
 * final leg (minus advances). Only the driver's auth entry is submitted: the platform does not
 * co-sign, so it cannot withhold this pay.
 */
export async function claimFinalPay(ctx: Ctx, driverId: number, tripId: string, req: FinalPayRequest, receivedAt = new Date()) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (trip.driverId !== driverId) throw forbidden();
    if (trip.status !== 'awaiting_signature') throw conflict('TRIP_NOT_AWAITING_SIGNATURE', `Trip is ${trip.status}`);
    const deviceTime = checkReleasePayload(req.payload, { tripId, assetId: trip.assetId, now: receivedAt });
    if (!isClaimable(trip, receivedAt)) {
      const deadline = trip.deliveryDeadline?.toISOString() ?? null;
      throw rejected('DEADLINE_NOT_PASSED', deadline ? `Final pay can be claimed after ${deadline}` : 'Trip has no delivery deadline', { deadline });
    }

    let hash: Buffer;
    try {
      hash = hashPayload(req.payload);
    } catch (e) {
      throw badRequest('BAD_PAYLOAD', (e as Error).message);
    }
    const driver = await getDriver(ctx, driverId);
    const args = TrailContract.args.claim_final_pay(tripId, hash);
    const entry = parseEntry(req.authEntry);
    const latest = await ctx.sub.latestLedger();
    const problem = ctx.trail.checkEntry(entry, driver.publicKey!, 'claim_final_pay', args, latest);
    if (problem) throw rejected('BAD_AUTH_ENTRY', problem);

    const waypoints = await getWaypoints(ctx, tripId);
    const last = waypoints.length - 1;
    let { payout, deduction } = finalPayAmount(trip, waypoints[last]!.legPay);
    const { tx } = await anchor(
      ctx,
      {
        assetId: trip.assetId,
        tripId,
        kind: Kind.RELEASE,
        wp: last,
        payload: req.payload,
        amount: payout,
        actor: `driver:${driverId}`,
        deviceTime,
        offline: false,
        authEntry: req.authEntry,
      },
      async () => {
        const tx = await ctx.trail.call('claim_final_pay', args, { kind: 'entries', entries: [entry] });
        const chain = (await ctx.trail.trip(tripId))!;
        await syncTrip(ctx, tripId, chain, { deliveredAt: tx.ledgerTime });
        const rec = chain.records.at(-1)!;
        // The ledger is authoritative for what was paid.
        if (rec.amount !== payout) {
          await ctx.db
            .update(schema.custodyEvents)
            .set({ amount: Number(rec.amount) })
            .where(and(eq(schema.custodyEvents.hash, hash.toString('hex')), eq(schema.custodyEvents.status, 'submitted')));
        }
        payout = rec.amount;
        deduction = chain.advanced;
        return { tx, seq: rec.seq };
      },
    );
    return {
      txHash: tx.txHash,
      payout: fromStroops(payout),
      deduction: fromStroops(deduction),
      balance: fromStroops(await usdcBalance(ctx, driver.publicKey!)),
    };
  });
}
