import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { randomToken } from '../lib/crypto.js';
import { conflict, forbidden, notFound, rejected } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { Kind, makePayload } from '../lib/payload.js';
import type { ChainTrip } from '../stellar/scval.js';
import { TrailContract } from '../stellar/trail.js';
import { anchor } from './anchoring.js';
import { usdcBalance } from './drivers.js';
import { getOrCreateReceiver } from './receivers.js';

export type Trip = typeof schema.trips.$inferSelect;
export type Waypoint = typeof schema.waypoints.$inferSelect;
export type TripStatus = Trip['status'];

export interface WaypointInput {
  name: string;
  type: 'pickup' | 'checkpoint' | 'delivery';
  lat: number;
  lon: number;
  radiusM?: number;
  windowStart: string;
  windowEnd: string;
  legPay: bigint;
}

export interface CreateTripInput {
  id?: string;
  assetId: string;
  driverId: number;
  receiver: { phone: string; name?: string };
  vehicle?: string;
  advanceLimit: bigint;
  waypoints: WaypointInput[];
}

/** Default geofence radius by waypoint type (journey 5.1 stage 2). */
export const DEFAULT_RADIUS_M = { pickup: 300, checkpoint: 200, delivery: 150 } as const;

/** Map the contract's status to ours (ours adds `accepted`). */
export function statusFromChain(s: ChainTrip['status']): TripStatus {
  return ({
    Funded: 'funded',
    InTransit: 'in_transit',
    AwaitingSignature: 'awaiting_signature',
    Disputed: 'disputed',
    Delivered: 'delivered',
    Cancelled: 'cancelled',
    Closed: 'closed',
  } as const)[s];
}

/** Apply the contract's view of a trip after a successful call. */
export async function syncTrip(ctx: Ctx, tripId: string, chain: ChainTrip, extra: Partial<Trip> = {}) {
  const current = await getTripRow(ctx, tripId);
  let status = statusFromChain(chain.status);
  if (status === 'funded' && current.status === 'accepted') status = 'accepted';
  await ctx.db
    .update(schema.trips)
    .set({ status, nextWp: chain.nextWp, released: Number(chain.released), advanced: Number(chain.advanced), ...extra })
    .where(eq(schema.trips.id, tripId));
}

export async function getTripRow(ctx: Ctx, id: string): Promise<Trip> {
  const t = await ctx.db.query.trips.findFirst({ where: eq(schema.trips.id, id) });
  if (!t) throw notFound('Trip');
  return t;
}

export async function getWaypoints(ctx: Ctx, tripId: string): Promise<Waypoint[]> {
  return ctx.db.select().from(schema.waypoints).where(eq(schema.waypoints.tripId, tripId)).orderBy(asc(schema.waypoints.idx));
}

function validateWaypoints(wps: WaypointInput[]) {
  if (wps.length < 2) throw rejected('INVALID_ROUTE', 'A route needs at least a pickup and a delivery');
  if (wps.length > 64) throw rejected('INVALID_ROUTE', 'At most 64 waypoints');
  wps.forEach((w, i) => {
    const expected = i === 0 ? 'pickup' : i === wps.length - 1 ? 'delivery' : 'checkpoint';
    if (w.type !== expected) throw rejected('INVALID_ROUTE', `Waypoint ${i} must be a ${expected}`);
    if (new Date(w.windowEnd) <= new Date(w.windowStart)) throw rejected('INVALID_ROUTE', `Waypoint ${i} window ends before it starts`);
    if (w.legPay < 0n) throw rejected('INVALID_ROUTE', `Waypoint ${i} has negative pay`);
  });
}

/**
 * Journey 5.1 stage 3 / T3: assign driver and receiver, then fund escrow from the treasury.
 * BR-01 (asset active) and BR-02 (escrow ≥ legs + advance limit) are checked here and again
 * by the contract.
 */
export async function createTrip(ctx: Ctx, input: CreateTripInput, staffId: number) {
  const id = input.id ?? `TR-${Date.now().toString(36).toUpperCase()}`;
  if (await ctx.db.query.trips.findFirst({ where: eq(schema.trips.id, id) })) throw conflict('TRIP_EXISTS');
  validateWaypoints(input.waypoints);

  const asset = await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, input.assetId) });
  if (!asset) throw notFound('Asset');
  if (asset.status !== 'active') throw rejected('ASSET_NOT_ACTIVE', 'Scan and activate the asset tag first (BR-01)');
  const busy = await ctx.db.query.trips.findFirst({
    where: and(eq(schema.trips.assetId, asset.id), inArray(schema.trips.status, ['funded', 'accepted', 'in_transit', 'awaiting_signature', 'disputed'])),
  });
  if (busy) throw conflict('ASSET_BUSY', `Asset is on trip ${busy.id}`);

  const driver = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.id, input.driverId) });
  if (!driver) throw notFound('Driver');
  if (driver.walletStatus !== 'ready' || !driver.publicKey) throw rejected('DRIVER_WALLET_NOT_READY', 'Driver has not finished onboarding');

  const legs = input.waypoints.map((w) => w.legPay);
  const escrow = legs.reduce((a, b) => a + b, 0n) + input.advanceLimit;
  const available = await usdcBalance(ctx, ctx.treasury.publicKey());
  if (available < escrow) {
    throw rejected('TREASURY_INSUFFICIENT', 'Treasury cannot cover the escrow (BR-02)', {
      required: fromStroops(escrow),
      available: fromStroops(available),
    });
  }

  const receiver = await getOrCreateReceiver(ctx, input.receiver.phone, input.receiver.name);
  const waypoints = input.waypoints.map((w, idx) => ({
    tripId: id,
    idx,
    name: w.name,
    type: w.type,
    lat: w.lat,
    lon: w.lon,
    radiusM: w.radiusM ?? DEFAULT_RADIUS_M[w.type],
    windowStart: new Date(w.windowStart),
    windowEnd: new Date(w.windowEnd),
    legPay: Number(w.legPay),
  }));
  const payload = makePayload('dispatch', {
    trip: id,
    asset: asset.id,
    driver: driver.publicKey,
    receiver: receiver.publicKey,
    vehicle: input.vehicle ?? null,
    advance_limit: fromStroops(input.advanceLimit),
    waypoints: waypoints.map((w) => ({
      idx: w.idx,
      name: w.name,
      type: w.type,
      lat: w.lat,
      lon: w.lon,
      radius_m: w.radiusM,
      window_start: w.windowStart.toISOString(),
      window_end: w.windowEnd.toISOString(),
      leg_pay: fromStroops(w.legPay),
    })),
  });

  await ctx.db.insert(schema.trips).values({
    id,
    assetId: asset.id,
    driverId: driver.id,
    receiverId: receiver.id,
    vehicle: input.vehicle,
    status: 'funded',
    advanceLimit: Number(input.advanceLimit),
    escrow: Number(escrow),
    trackingToken: randomToken(18),
    createdBy: staffId,
  });
  await ctx.db.insert(schema.waypoints).values(waypoints);

  try {
    const { event, tx } = await anchor(
      ctx,
      { assetId: asset.id, tripId: id, kind: Kind.DISPATCH, payload, amount: escrow, actor: `staff:${staffId}` },
      async (hash) => {
        const args = TrailContract.args.create_trip({
          id,
          asset: asset.id,
          driver: driver.publicKey!,
          receiver: receiver.publicKey,
          funder: ctx.treasury.publicKey(),
          legs,
          advanceLimit: input.advanceLimit,
          planHash: hash,
        });
        const tx = await ctx.trail.call('create_trip', args, { kind: 'record', signers: [ctx.admin, ctx.treasury] });
        const chain = await ctx.trail.trip(id);
        return { tx, seq: chain!.records[0]!.seq };
      },
    );
    const trip = await getTripRow(ctx, id);
    await ctx.sms.send(
      receiver.phone,
      `Your delivery ${id} (${asset.name}) is on its way. Track it: ${ctx.config.PUBLIC_BASE_URL}/t/${trip.trackingToken}`,
    );
    return { trip: await tripView(ctx, id), event, txHash: tx.txHash };
  } catch (e) {
    await ctx.db.delete(schema.custodyEvents).where(eq(schema.custodyEvents.tripId, id));
    await ctx.db.delete(schema.waypoints).where(eq(schema.waypoints.tripId, id));
    await ctx.db.delete(schema.trips).where(eq(schema.trips.id, id));
    throw e;
  }
}

/** Journey 5.2 stage 2: driver accepts the offer. */
export async function acceptTrip(ctx: Ctx, tripId: string, driverId: number) {
  const trip = await getTripRow(ctx, tripId);
  if (trip.driverId !== driverId) throw forbidden();
  if (trip.status !== 'funded') throw conflict('NOT_OFFERED', `Trip is ${trip.status}`);
  await ctx.db.update(schema.trips).set({ status: 'accepted', acceptedAt: new Date() }).where(eq(schema.trips.id, tripId));
  return tripView(ctx, tripId);
}

const money = (n: number | bigint) => fromStroops(BigInt(n));

/** Full trip view used by the portal and the driver app. */
export async function tripView(ctx: Ctx, tripId: string) {
  const trip = await getTripRow(ctx, tripId);
  const [waypoints, events, advances, live, asset, driver] = await Promise.all([
    getWaypoints(ctx, tripId),
    ctx.db.select().from(schema.custodyEvents).where(eq(schema.custodyEvents.tripId, tripId)).orderBy(asc(schema.custodyEvents.id)),
    ctx.db.select().from(schema.advances).where(eq(schema.advances.tripId, tripId)).orderBy(desc(schema.advances.id)),
    ctx.db.query.livePositions.findFirst({ where: eq(schema.livePositions.tripId, tripId) }),
    ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, trip.assetId) }),
    ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.id, trip.driverId) }),
  ]);
  const last = waypoints.length - 1;
  const checkinKinds: number[] = [Kind.PICKUP, Kind.CHECKIN, Kind.ARRIVAL, Kind.FORCED_CHECKIN, Kind.DELIVERY];
  const verified = (idx: number) =>
    events.find((e) => e.status === 'confirmed' && e.wp === idx && checkinKinds.includes(e.kind) && e.kind !== Kind.DELIVERY);
  return {
    id: trip.id,
    status: trip.status,
    asset: asset && { id: asset.id, name: asset.name, serial: asset.serial },
    driver: driver && { id: driver.id, name: driver.name, address: driver.publicKey },
    vehicle: trip.vehicle,
    escrow: {
      funded: money(trip.escrow),
      released: money(trip.released),
      advances: money(trip.advanced),
      left: money(trip.escrow - trip.released),
      advanceLimit: money(trip.advanceLimit),
      funded_badge: trip.status !== 'cancelled' && trip.status !== 'closed',
    },
    nextWp: trip.nextWp,
    waypoints: waypoints.map((w) => {
      const v = verified(w.idx);
      return {
        idx: w.idx,
        name: w.name,
        type: w.type,
        lat: w.lat,
        lon: w.lon,
        radiusM: w.radiusM,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        legPay: money(w.legPay),
        payNote: w.idx === last ? 'paid when the receiver signs' : undefined,
        state: v ? 'verified' : w.idx === trip.nextWp ? 'next' : w.idx < trip.nextWp ? 'pending' : 'remaining',
        verified: v
          ? { txHash: v.txHash, ledgerTime: v.ledgerTime, deviceTime: v.deviceTime, offline: v.offline, forced: v.kind === Kind.FORCED_CHECKIN }
          : null,
      };
    }),
    /** Live GPS estimate — never mixed with ledger-verified positions (principle 5). */
    live: live ? { lat: live.lat, lon: live.lon, accM: live.accM, at: live.at, estimate: true } : null,
    advances: advances.map((a) => ({ ...a, amount: money(a.amount) })),
    events,
    trackingUrl: `${ctx.config.PUBLIC_BASE_URL}/t/${trip.trackingToken}`,
    contractId: ctx.trail.contractId,
    createdAt: trip.createdAt,
  };
}

/** Trips board: table rows + the "needs attention" queue (§6.1). */
export async function tripsBoard(ctx: Ctx, now = new Date()) {
  const trips = await ctx.db.select().from(schema.trips).where(ne(schema.trips.status, 'closed')).orderBy(desc(schema.trips.createdAt));
  const rows = [];
  const attention: { tripId: string; kind: string; detail: string; actions: string[] }[] = [];
  for (const t of trips) {
    const wps = await getWaypoints(ctx, t.id);
    const events = await ctx.db
      .select()
      .from(schema.custodyEvents)
      .where(and(eq(schema.custodyEvents.tripId, t.id), eq(schema.custodyEvents.status, 'confirmed')))
      .orderBy(desc(schema.custodyEvents.id));
    const lastCheckin = events.find((e) => [Kind.PICKUP, Kind.CHECKIN, Kind.ARRIVAL, Kind.FORCED_CHECKIN].includes(e.kind as 4));
    const next = wps[t.nextWp];
    let display: string = t.status;
    const moving = ['funded', 'accepted', 'in_transit'].includes(t.status);
    if (moving && next && now > next.windowEnd) {
      display = 'missed_waypoint';
      attention.push({ tripId: t.id, kind: 'missed_waypoint', detail: `${next.name} window closed`, actions: ['call_driver', 'extend_window', 'force_checkin'] });
    } else if (moving && next && now > next.windowStart && now.getTime() > (next.windowStart.getTime() + next.windowEnd.getTime()) / 2) {
      display = 'behind_schedule';
      attention.push({ tripId: t.id, kind: 'behind_schedule', detail: `Not yet at ${next.name}`, actions: ['call_driver'] });
    }
    if (t.status === 'awaiting_signature' && t.arrivedAt && now.getTime() - t.arrivedAt.getTime() > 2 * 3_600_000) {
      attention.push({ tripId: t.id, kind: 'signature_overdue', detail: 'Receiver has not signed', actions: ['remind_receiver'] });
    }
    if (t.status === 'disputed') attention.push({ tripId: t.id, kind: 'disputed', detail: 'Problem reported', actions: ['resolve'] });
    const requested = await ctx.db
      .select()
      .from(schema.advances)
      .where(and(eq(schema.advances.tripId, t.id), eq(schema.advances.status, 'requested')));
    for (const a of requested) {
      attention.push({ tripId: t.id, kind: 'advance_request', detail: `${money(a.amount)} requested`, actions: ['approve', 'decline'] });
    }
    rows.push({
      id: t.id,
      assetId: t.assetId,
      driverId: t.driverId,
      status: display,
      lastVerified: lastCheckin ? { wp: lastCheckin.wp, txHash: lastCheckin.txHash, at: lastCheckin.ledgerTime } : null,
      next: next ? { idx: next.idx, name: next.name, windowStart: next.windowStart, windowEnd: next.windowEnd } : null,
      escrowLeft: money(t.escrow - t.released),
    });
  }
  return { trips: rows, attention };
}
