import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { conflict, forbidden, notFound, rejected } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { TrailContract } from '../stellar/trail.js';
import { getDriver } from './drivers.js';
import { parseEntry, tripLocks } from './checkins.js';
import { getTripRow, getWaypoints, syncTrip } from './trips.js';

/** BR-06: the cap that keeps every advance recoverable from the final leg. */
export async function advanceRoom(ctx: Ctx, tripId: string) {
  const trip = await getTripRow(ctx, tripId);
  const wps = await getWaypoints(ctx, tripId);
  const cap = BigInt(Math.min(trip.advanceLimit, wps.at(-1)!.legPay));
  return { cap, room: cap - BigInt(trip.advanced) };
}

/** Journey 5.2 stage 5: driver asks for a fuel advance. */
export async function requestAdvance(ctx: Ctx, driverId: number, tripId: string, amount: bigint, reason?: string) {
  const trip = await getTripRow(ctx, tripId);
  if (trip.driverId !== driverId) throw forbidden();
  if (!['funded', 'accepted', 'in_transit'].includes(trip.status)) throw conflict('TRIP_NOT_MOVING');
  const { room } = await advanceRoom(ctx, tripId);
  if (amount <= 0n || amount > room) throw rejected('ADVANCE_OVER_LIMIT', `At most ${fromStroops(room)} available`, { available: fromStroops(room) });
  const [row] = await ctx.db.insert(schema.advances).values({ tripId, amount: Number(amount), reason, status: 'requested' }).returning();
  return row!;
}

/** T6: ops approves; the contract holds the advance claimable until the deadline. */
export async function approveAdvance(ctx: Ctx, advanceId: number, staffId: number, expiresInHours = 24) {
  const adv = await ctx.db.query.advances.findFirst({ where: eq(schema.advances.id, advanceId) });
  if (!adv) throw notFound('Advance');
  if (adv.status !== 'requested') throw conflict('ADVANCE_NOT_REQUESTED', `Advance is ${adv.status}`);
  const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);
  return tripLocks.run(adv.tripId, async () => {
    const tx = await ctx.trail.call(
      'grant_advance',
      TrailContract.args.grant_advance(adv.tripId, BigInt(adv.amount), Math.floor(expiresAt.getTime() / 1000)),
      { kind: 'record', signers: [ctx.admin] },
    );
    const [row] = await ctx.db
      .update(schema.advances)
      .set({ status: 'granted', expiresAt, grantTx: tx.txHash, decidedBy: staffId })
      .where(eq(schema.advances.id, advanceId))
      .returning();
    return row!;
  });
}

export async function declineAdvance(ctx: Ctx, advanceId: number, staffId: number) {
  const [row] = await ctx.db
    .update(schema.advances)
    .set({ status: 'declined', decidedBy: staffId })
    .where(and(eq(schema.advances.id, advanceId), eq(schema.advances.status, 'requested')))
    .returning();
  if (!row) throw conflict('ADVANCE_NOT_REQUESTED');
  return row;
}

/** T7: the driver claims with a phone-signed auth entry for claim_advance(trip). */
export async function claimAdvance(ctx: Ctx, driverId: number, tripId: string, authEntry: string) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (trip.driverId !== driverId) throw forbidden();
    const adv = await ctx.db.query.advances.findFirst({
      where: and(eq(schema.advances.tripId, tripId), eq(schema.advances.status, 'granted')),
    });
    if (!adv) throw notFound('Granted advance');
    if (adv.expiresAt && adv.expiresAt < new Date()) {
      await ctx.db.update(schema.advances).set({ status: 'expired' }).where(eq(schema.advances.id, adv.id));
      throw rejected('ADVANCE_EXPIRED');
    }
    const driver = await getDriver(ctx, driverId);
    const args = TrailContract.args.claim_advance(tripId);
    const entry = parseEntry(authEntry);
    const problem = ctx.trail.checkEntry(entry, driver.publicKey!, 'claim_advance', args, await ctx.sub.latestLedger());
    if (problem) throw rejected('BAD_AUTH_ENTRY', problem);
    const tx = await ctx.trail.call('claim_advance', args, { kind: 'entries', entries: [entry] });
    await syncTrip(ctx, tripId, (await ctx.trail.trip(tripId))!);
    const [row] = await ctx.db.update(schema.advances).set({ status: 'claimed', claimTx: tx.txHash }).where(eq(schema.advances.id, adv.id)).returning();
    return row!;
  });
}
