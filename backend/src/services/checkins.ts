import { xdr } from '@stellar/stellar-sdk';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { badRequest, conflict, forbidden, rejected } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { KeyedMutex } from '../lib/mutex.js';
import { hashPayload, Kind, type WaypointPayload } from '../lib/payload.js';
import { TrailContract } from '../stellar/trail.js';
import { anchor } from './anchoring.js';
import { getDriver, usdcBalance } from './drivers.js';
import { CheckInRejected, checkWaypoint } from './signer.js';
import { getTripRow, getWaypoints, syncTrip } from './trips.js';

export const tripLocks = new KeyedMutex();

export interface CheckInRequest {
  payload: WaypointPayload;
  /** Driver-signed Soroban auth entry for check_in(trip, wp, sha256(payload)), base64 XDR. */
  authEntry: string;
}

export function parseEntry(b64: string): xdr.SorobanAuthorizationEntry {
  try {
    return xdr.SorobanAuthorizationEntry.fromXdr(b64, 'base64');
  } catch {
    throw badRequest('BAD_AUTH_ENTRY', 'authEntry must be a base64 SorobanAuthorizationEntry');
  }
}

/**
 * Journey 5.2 stages 3–4 / T4–T5. The signer service checks BR-03 (geofence, tag, next
 * waypoint, window), verifies the phone's auth entry is for exactly this payload hash, adds the
 * platform co-signature and submits: location hash + leg pay in one transaction (BR-04).
 */
export async function submitCheckIn(ctx: Ctx, driverId: number, tripId: string, req: CheckInRequest, receivedAt = new Date()) {
  return tripLocks.run(tripId, async () => {
    const trip = await getTripRow(ctx, tripId);
    if (trip.driverId !== driverId) throw forbidden();
    if (!['funded', 'accepted', 'in_transit'].includes(trip.status)) throw conflict('TRIP_NOT_MOVING', `Trip is ${trip.status}`);
    const driver = await getDriver(ctx, driverId);
    const asset = (await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, trip.assetId) }))!;
    const waypoints = await getWaypoints(ctx, tripId);
    const last = waypoints.length - 1;

    let hash: Buffer;
    try {
      hash = hashPayload(req.payload);
    } catch (e) {
      throw badRequest('BAD_PAYLOAD', (e as Error).message);
    }
    // Idempotent re-submit from the offline queue.
    const dup = await ctx.db.query.custodyEvents.findFirst({
      where: and(eq(schema.custodyEvents.hash, hash.toString('hex')), eq(schema.custodyEvents.status, 'confirmed')),
    });
    if (dup) return { duplicate: true, event: dup, txHash: dup.txHash };

    let checks;
    try {
      checks = checkWaypoint(req.payload, {
        tripId,
        assetId: asset.id,
        tagId: asset.tagId,
        nextWp: trip.nextWp,
        waypoint: waypoints[req.payload.wp],
        lastWp: last,
        now: receivedAt,
        maxOfflineHours: ctx.config.OFFLINE_MAX_HOURS,
      });
    } catch (e) {
      if (e instanceof CheckInRejected) {
        if (e.code === 'TAG_MISMATCH') ctx.log.warn({ tripId, driverId }, 'tag mismatch at check-in — ops alerted');
        throw rejected(e.code, e.message, e.details);
      }
      throw e;
    }

    const wp = req.payload.wp;
    const args = TrailContract.args.check_in(tripId, wp, hash);
    const entry = parseEntry(req.authEntry);
    const latest = await ctx.sub.latestLedger();
    const problem = ctx.trail.checkEntry(entry, driver.publicKey!, 'check_in', args, latest);
    if (problem) throw rejected('BAD_AUTH_ENTRY', problem);

    const deviceTime = new Date(req.payload.t_device);
    const offline = receivedAt.getTime() - deviceTime.getTime() > ctx.config.OFFLINE_GAP_FLAG_SECONDS * 1000;
    const kind = wp === 0 ? Kind.PICKUP : wp === last ? Kind.ARRIVAL : Kind.CHECKIN;
    const legPay = wp === last ? 0n : BigInt(waypoints[wp]!.legPay);

    const { event, tx } = await anchor(
      ctx,
      {
        assetId: asset.id,
        tripId,
        kind,
        wp,
        payload: req.payload,
        amount: legPay,
        actor: `driver:${driverId}`,
        deviceTime,
        offline,
        authEntry: req.authEntry,
      },
      async () => {
        const platform = await ctx.signer.coSign('check_in', args, latest);
        const tx = await ctx.trail.call('check_in', args, { kind: 'entries', entries: [entry, platform] });
        const chain = (await ctx.trail.trip(tripId))!;
        await syncTrip(ctx, tripId, chain, wp === last ? { arrivedAt: tx.ledgerTime } : {});
        return { tx, seq: chain.records.at(-1)!.seq };
      },
    );

    if (wp === last) {
      const receiver = await ctx.db.query.receivers.findFirst({ where: eq(schema.receivers.id, trip.receiverId) });
      if (receiver) {
        await ctx.sms.send(
          receiver.phone,
          `${asset.name} has arrived (${tripId}). Please inspect and sign: ${ctx.config.PUBLIC_BASE_URL}/t/${trip.trackingToken}`,
        );
      }
    }
    const next = waypoints[wp + 1];
    return {
      duplicate: false,
      event,
      txHash: tx.txHash,
      checks: { ...checks, recordedOnLedger: true },
      legPay: fromStroops(legPay),
      balance: fromStroops(await usdcBalance(ctx, driver.publicKey!)),
      next: wp === last ? null : next && { idx: next.idx, name: next.name, windowStart: next.windowStart, windowEnd: next.windowEnd },
      awaitingSignature: wp === last,
    };
  });
}

/**
 * §4.4 offline queue: check-ins signed offline are submitted in order. Stops at the first
 * failure so later ones aren't attempted out of order.
 */
export async function submitQueue(ctx: Ctx, driverId: number, tripId: string, items: CheckInRequest[]) {
  const results: unknown[] = [];
  for (const [i, item] of items.entries()) {
    try {
      results.push({ index: i, ok: true, ...(await submitCheckIn(ctx, driverId, tripId, item)) });
    } catch (e) {
      const err = e as { code?: string; message: string };
      results.push({ index: i, ok: false, code: err.code ?? 'ERROR', message: err.message });
      return { results, stoppedAt: i };
    }
  }
  return { results, stoppedAt: null };
}

/** Live GPS estimate (dashed line). Never anchored, never shown as verified. */
export async function reportLocation(ctx: Ctx, driverId: number, tripId: string, p: { lat: number; lon: number; accM?: number }) {
  const trip = await getTripRow(ctx, tripId);
  if (trip.driverId !== driverId) throw forbidden();
  const row = { tripId, lat: p.lat, lon: p.lon, accM: p.accM ?? null, at: new Date() };
  await ctx.db.insert(schema.livePositions).values(row).onConflictDoUpdate({ target: schema.livePositions.tripId, set: row });
  return row;
}
