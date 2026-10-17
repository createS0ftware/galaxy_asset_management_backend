import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { schema } from '../../db/client.js';
import { fromStroops } from '../../lib/money.js';
import { Kind } from '../../lib/payload.js';
import { claimAdvance, requestAdvance } from '../../services/advances.js';
import { prepareCashout, quoteCashout, submitCashout } from '../../services/cashout.js';
import { reportLocation, submitCheckIn, submitQueue } from '../../services/checkins.js';
import { getDriver, prepareWallet, submitWallet, usdcBalance } from '../../services/drivers.js';
import { claimFinalPay, finalPayTemplate } from '../../services/release.js';
import { eventFor } from '../../services/signer.js';
import { acceptTrip, getTripRow, tripView } from '../../services/trips.js';
import { requireRole, who } from '../auth.js';
import { money, parse } from '../validate.js';
import { forbidden } from '../../lib/errors.js';

type P<T extends string> = { Params: Record<T, string> };

/** Custody kinds whose amount went to the driver: leg pay, forced check-ins and the final leg. */
const DRIVER_PAID_KINDS: number[] = [Kind.PICKUP, Kind.CHECKIN, Kind.FORCED_CHECKIN, Kind.DELIVERY, Kind.RESOLVE, Kind.RELEASE];

const checkIn = z.object({
  payload: z
    .object({
      v: z.literal(1),
      event: z.enum(['pickup', 'checkin', 'arrival']),
      trip: z.string(),
      wp: z.number().int().nonnegative(),
      asset: z.string(),
      tag: z.string(),
      lat: z.number(),
      lon: z.number(),
      acc_m: z.number(),
      t_device: z.string(),
      photos: z.array(z.string()),
      salt: z.string(),
    })
    .passthrough(),
  authEntry: z.string().min(1),
});

/** POST /trips/:id/final-pay: release payload + driver auth entry for claim_final_pay(trip, sha256(payload)). */
export const finalPayBody = z.object({
  payload: z
    .object({
      v: z.literal(1),
      event: z.literal('release'),
      trip: z.string(),
      asset: z.string(),
      t_device: z.string(),
      salt: z.string(),
    })
    .passthrough(),
  authEntry: z.string().min(1),
});

/** Driver app (journey 5.2). All routes need a driver token. */
export const driverRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireRole(ctx, 'driver'));

    const ownTrip = async (driverId: number, tripId: string) => {
      const t = await getTripRow(ctx, tripId);
      if (t.driverId !== driverId) throw forbidden();
      return t;
    };

    app.get('/me', async (req) => {
      const d = await getDriver(ctx, who(req));
      return { id: d.id, name: d.name, phone: d.phone, walletStatus: d.walletStatus, address: d.publicKey, momoNumber: d.momoNumber };
    });

    // ------------------------------------------------------------- wallet
    app.post('/wallet/prepare', async (req) => {
      const { publicKey } = parse(z.object({ publicKey: z.string() }), req.body);
      return prepareWallet(ctx, who(req), publicKey);
    });
    app.post('/wallet/submit', async (req) => {
      const { xdr } = parse(z.object({ xdr: z.string() }), req.body);
      return submitWallet(ctx, who(req), xdr);
    });
    app.get('/wallet', async (req) => {
      const d = await getDriver(ctx, who(req));
      const balance = d.publicKey ? await usdcBalance(ctx, d.publicKey) : 0n;
      const tripIds = (await ctx.db.select({ id: schema.trips.id }).from(schema.trips).where(eq(schema.trips.driverId, d.id))).map((t) => t.id);
      const activity = tripIds.length
        ? await ctx.db
            .select()
            .from(schema.custodyEvents)
            .where(and(inArray(schema.custodyEvents.tripId, tripIds), eq(schema.custodyEvents.status, 'confirmed')))
        : [];
      const advances = tripIds.length ? await ctx.db.select().from(schema.advances).where(inArray(schema.advances.tripId, tripIds)) : [];
      const cashouts = await ctx.db.select().from(schema.cashouts).where(eq(schema.cashouts.driverId, d.id));
      return {
        balance: fromStroops(balance),
        asset: ctx.config.PAY_ASSET.split(':')[0],
        networkFees: 'paid by the platform',
        advanceReady: advances.filter((a) => a.status === 'granted').map((a) => ({ id: a.id, trip: a.tripId, amount: fromStroops(BigInt(a.amount)), claimBy: a.expiresAt })),
        activity: [
          // Only events that paid the driver: the dispatch event carries the escrow the funder put in.
          ...activity
            .filter((e) => e.amount > 0 && DRIVER_PAID_KINDS.includes(e.kind))
            .map((e) => ({ type: 'leg', kind: e.kind, trip: e.tripId, wp: e.wp, amount: fromStroops(BigInt(e.amount)), txHash: e.txHash, at: e.ledgerTime })),
          ...advances.filter((a) => a.status === 'claimed').map((a) => ({ type: 'advance', trip: a.tripId, amount: fromStroops(BigInt(a.amount)), txHash: a.claimTx, at: a.createdAt })),
          ...cashouts.map((c) => ({ type: 'cashout', id: c.id, status: c.status, amount: fromStroops(BigInt(-c.amount)), txHash: c.txHash, at: c.createdAt })),
        ],
        cashouts: cashouts.map((c) => {
          const q = c.quote as { fee: string; buyAmount: string; buyAsset: string; rate: string; arrival?: string };
          return {
            id: c.id,
            amount: fromStroops(BigInt(c.amount)),
            fee: fromStroops(BigInt(q.fee)),
            buyAmount: q.buyAmount,
            buyCurrency: q.buyAsset.split(':')[1],
            rate: q.rate,
            arrival: q.arrival,
            status: c.status,
            txHash: c.txHash,
            error: c.error,
            createdAt: c.createdAt,
          };
        }),
      };
    });

    // -------------------------------------------------------------- trips
    app.get('/trips', async (req) => {
      const rows = await ctx.db.select().from(schema.trips).where(eq(schema.trips.driverId, who(req)));
      return Promise.all(rows.map((t) => tripView(ctx, t.id)));
    });
    app.get<P<'id'>>('/trips/:id', async (req) => {
      const t = await ownTrip(who(req), req.params.id);
      const view = await tripView(ctx, t.id);
      const last = view.waypoints.length - 1;
      return {
        ...view,
        events: undefined,
        /** What the phone needs to build and sign the next check-in, even offline later. */
        checkIn:
          t.nextWp <= last && ['funded', 'accepted', 'in_transit'].includes(t.status)
            ? {
                contractId: ctx.trail.contractId,
                networkPassphrase: ctx.sub.passphrase,
                wp: t.nextWp,
                event: eventFor(t.nextWp, last),
                asset: t.assetId,
                latestLedger: await ctx.sub.latestLedger(),
                ledgerSeconds: 5,
                maxOfflineHours: ctx.config.OFFLINE_MAX_HOURS,
              }
            : null,
        /** While the receiver hasn't signed: the final leg the driver can claim after the deadline (§4.6). */
        finalPay: t.status === 'awaiting_signature' ? await finalPayTemplate(ctx, t) : null,
      };
    });
    app.post<P<'id'>>('/trips/:id/accept', (req) => acceptTrip(ctx, req.params.id, who(req)));
    app.post<P<'id'>>('/trips/:id/checkins', async (req, reply) => {
      const b = parse(checkIn, req.body);
      return reply.status(201).send(await submitCheckIn(ctx, who(req), req.params.id, b as never));
    });
    app.post<P<'id'>>('/trips/:id/checkins/batch', async (req) => {
      const b = parse(z.object({ items: z.array(checkIn).min(1).max(64) }), req.body);
      return submitQueue(ctx, who(req), req.params.id, b.items as never);
    });
    app.post<P<'id'>>('/trips/:id/location', async (req) => {
      const b = parse(z.object({ lat: z.number(), lon: z.number(), accM: z.number().int().optional() }), req.body);
      return reportLocation(ctx, who(req), req.params.id, b);
    });
    app.post<P<'id'>>('/trips/:id/advances', async (req, reply) => {
      const b = parse(z.object({ amount: money, reason: z.string().optional() }), req.body);
      const row = await requestAdvance(ctx, who(req), req.params.id, b.amount, b.reason);
      return reply.status(201).send({ ...row, amount: fromStroops(BigInt(row.amount)) });
    });
    app.post<P<'id'>>('/trips/:id/advances/claim', async (req) => {
      const { authEntry } = parse(z.object({ authEntry: z.string() }), req.body);
      const row = await claimAdvance(ctx, who(req), req.params.id, authEntry);
      return { ...row, amount: fromStroops(BigInt(row.amount)) };
    });
    app.post<P<'id'>>('/trips/:id/final-pay', async (req) => {
      const b = parse(finalPayBody, req.body);
      return claimFinalPay(ctx, who(req), req.params.id, b);
    });

    // ------------------------------------------------------------ cash-out
    app.post('/cashouts/quote', async (req) => {
      const { amount } = parse(z.object({ amount: money }), req.body);
      return quoteCashout(ctx, who(req), amount);
    });
    app.post<P<'id'>>('/cashouts/:id/prepare', (req) => prepareCashout(ctx, who(req), Number(req.params.id)));
    app.post<P<'id'>>('/cashouts/:id/submit', async (req) => {
      const { xdr } = parse(z.object({ xdr: z.string() }), req.body);
      return submitCashout(ctx, who(req), Number(req.params.id), xdr);
    });
  };
