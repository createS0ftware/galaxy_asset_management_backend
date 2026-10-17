import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { activateAsset, getAsset, listAssets, registerAsset } from '../../services/assets.js';
import { approveAdvance, declineAdvance } from '../../services/advances.js';
import { createDriver, listDrivers } from '../../services/drivers.js';
import { cancelTrip, closeTrip, forceCheckIn, logOverride, resolveDispute } from '../../services/overrides.js';
import { paymentsSummary, reconciliationCsv } from '../../services/payments.js';
import { createTrip, tripsBoard, tripView } from '../../services/trips.js';
import { createProofLink, verifyAsset } from '../../services/verify.js';
import { requireRole, who } from '../auth.js';
import { hex32, money, parse, phone } from '../validate.js';
import { fromStroops } from '../../lib/money.js';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
type P<T extends string> = { Params: Record<T, string> };

/** Operations-manager portal (journey 5.1). All routes need a staff token. */
export const portalRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook('preHandler', requireRole(ctx, 'staff'));

    // ------------------------------------------------------------- assets
    app.get('/assets', () => listAssets(ctx));
    app.post('/assets', async (req, reply) => {
      const body = parse(
        z.object({
          id,
          name: z.string().min(1),
          type: z.string().min(1),
          serial: z.string().min(1),
          value: z.string().optional(),
          tagId: z.string().min(1),
          documents: z.array(z.object({ name: z.string(), sha256: hex32 })).optional(),
        }),
        req.body,
      );
      return reply.status(201).send(await registerAsset(ctx, body, who(req)));
    });
    app.get<P<'id'>>('/assets/:id', (req) => getAsset(ctx, req.params.id));
    app.post<P<'id'>>('/assets/:id/activate', async (req) => {
      const { tag } = parse(z.object({ tag: z.string().min(1) }), req.body);
      return activateAsset(ctx, req.params.id, tag, who(req));
    });
    app.post<P<'id'>>('/assets/:id/proof-links', async (req, reply) => {
      const b = parse(z.object({ days: z.number().positive().max(365).optional(), note: z.string().optional() }), req.body ?? {});
      return reply.status(201).send(await createProofLink(ctx, req.params.id, who(req), b.days, b.note));
    });
    app.get<P<'id'>>('/assets/:id/verify', (req) => verifyAsset(ctx, req.params.id));

    // ------------------------------------------------------------ drivers
    app.get('/drivers', () => listDrivers(ctx));
    app.post('/drivers', async (req, reply) => {
      const b = parse(z.object({ phone, name: z.string().min(1), momoNumber: phone.optional() }), req.body);
      return reply.status(201).send(await createDriver(ctx, b));
    });

    // -------------------------------------------------------------- trips
    app.get('/trips', () => tripsBoard(ctx));
    app.post('/trips', async (req, reply) => {
      const b = parse(
        z.object({
          id: id.optional(),
          assetId: id,
          driverId: z.number().int(),
          receiver: z.object({ phone, name: z.string().optional() }),
          vehicle: z.string().optional(),
          advanceLimit: money,
          waypoints: z
            .array(
              z.object({
                name: z.string().min(1),
                type: z.enum(['pickup', 'checkpoint', 'delivery']),
                lat: z.number().min(-90).max(90),
                lon: z.number().min(-180).max(180),
                radiusM: z.number().int().positive().max(50_000).optional(),
                windowStart: z.string().datetime(),
                windowEnd: z.string().datetime(),
                legPay: money,
              }),
            )
            .min(2),
        }),
        req.body,
      );
      return reply.status(201).send(await createTrip(ctx, b, who(req)));
    });
    app.get<P<'id'>>('/trips/:id', (req) => tripView(ctx, req.params.id));

    app.post<P<'id'>>('/trips/:id/overrides', async (req) => {
      const b = parse(
        z.object({
          kind: z.enum(['extend_window', 'reroute', 'pay_hold', 'pay_release', 'note']),
          reason: z.string().min(3),
          wp: z.number().int().nonnegative().optional(),
          windowEnd: z.string().datetime().optional(),
        }),
        req.body,
      );
      return logOverride(ctx, req.params.id, who(req), b);
    });
    app.post<P<'id'>>('/trips/:id/force-checkin', async (req) => {
      const b = parse(z.object({ wp: z.number().int().nonnegative(), reason: z.string().min(3), lat: z.number().optional(), lon: z.number().optional() }), req.body);
      return forceCheckIn(ctx, req.params.id, who(req), b);
    });
    app.post<P<'id'>>('/trips/:id/resolve', async (req) => {
      const b = parse(z.object({ resolution: z.enum(['resume', 'release']), pay: money.optional(), reason: z.string().min(3) }), req.body);
      const resolution = b.resolution === 'resume' ? ({ kind: 'resume' } as const) : ({ kind: 'release', pay: b.pay ?? 0n } as const);
      return resolveDispute(ctx, req.params.id, who(req), { resolution, reason: b.reason });
    });
    app.post<P<'id'>>('/trips/:id/cancel', async (req) => {
      const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
      return cancelTrip(ctx, req.params.id, who(req), reason);
    });
    app.post<P<'id'>>('/trips/:id/close', async (req) => {
      const r = await closeTrip(ctx, req.params.id);
      return { txHash: r.txHash, refunded: fromStroops(BigInt(r.refunded)) };
    });

    // ----------------------------------------------------------- advances
    app.post<P<'id'>>('/advances/:id/approve', async (req) => {
      const b = parse(z.object({ expiresInHours: z.number().positive().max(168).optional() }), req.body ?? {});
      return approveAdvance(ctx, Number(req.params.id), who(req), b.expiresInHours);
    });
    app.post<P<'id'>>('/advances/:id/decline', (req) => declineAdvance(ctx, Number(req.params.id), who(req)));

    // ----------------------------------------------------------- payments
    app.get('/payments/summary', () => paymentsSummary(ctx));
    app.get('/payments/reconciliation.csv', async (_req, reply) =>
      reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="reconciliation.csv"').send(await reconciliationCsv(ctx)),
    );
  };
