import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../context.js';
import { schema } from '../../db/client.js';
import { verifyPassword } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/errors.js';
import { checkOtp, sendOtp } from '../../services/otp.js';
import { reportProblem, sendSignOtp, signDelivery, trackingView } from '../../services/tracking.js';
import { eventPayload, openProofLink, proofPack, verifyAsset } from '../../services/verify.js';
import { issueToken } from '../auth.js';
import { parse, phone } from '../validate.js';

type P<T extends string> = { Params: Record<T, string> };

/** Unauthenticated routes: login, tracking link (5.3), verify view (5.4), network info. */
export const publicRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.get('/network', async () => ({
      networkPassphrase: ctx.sub.passphrase,
      rpcUrl: ctx.config.STELLAR_RPC_URL,
      contractId: ctx.trail.contractId,
      payAsset: ctx.config.PAY_ASSET,
      latestLedger: await ctx.sub.latestLedger(),
    }));

    // --------------------------------------------------------------- auth
    app.post('/auth/staff/login', async (req) => {
      const b = parse(z.object({ email: z.string().email(), password: z.string() }), req.body);
      const user = await ctx.db.query.staffUsers.findFirst({ where: eq(schema.staffUsers.email, b.email) });
      if (!user || !(await verifyPassword(b.password, user.passwordHash))) throw unauthorized('Wrong email or password');
      return { token: await issueToken(ctx, { role: 'staff', id: user.id }), user: { id: user.id, name: user.name, role: user.role } };
    });
    app.post('/auth/driver/otp', async (req) => {
      const b = parse(z.object({ phone }), req.body);
      const d = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.phone, b.phone) });
      if (d) await sendOtp(ctx, b.phone, 'driver-login', (code) => `Your sign-in code: ${code}`);
      return { sent: true }; // same answer either way: don't reveal who's registered
    });
    app.post('/auth/driver/verify', async (req) => {
      const b = parse(z.object({ phone, code: z.string().length(6) }), req.body);
      const d = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.phone, b.phone) });
      if (!d || !(await checkOtp(ctx, b.phone, 'driver-login', b.code))) throw unauthorized('Invalid or expired code');
      return { token: await issueToken(ctx, { role: 'driver', id: d.id }, '30d'), driver: { id: d.id, name: d.name } };
    });

    // ----------------------------------------------------------- tracking
    app.get<P<'token'>>('/track/:token', (req) => trackingView(ctx, req.params.token));
    app.post<P<'token'>>('/track/:token/otp', (req) => sendSignOtp(ctx, req.params.token));
    app.post<P<'token'>>('/track/:token/sign', async (req) => {
      const b = parse(z.object({ code: z.string().length(6), tag: z.string(), noDamage: z.boolean() }), req.body);
      return signDelivery(ctx, req.params.token, b);
    });
    app.post<P<'token'>>('/track/:token/report', async (req) => {
      const b = parse(
        z.object({ code: z.string().length(6), notes: z.string().min(3), photos: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)) }),
        req.body,
      );
      return reportProblem(ctx, req.params.token, b);
    });

    // ------------------------------------------------------------- verify
    const view = (req: { ip: string; headers: Record<string, unknown> }, what: string) => ({
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      what,
    });
    app.get<P<'token'> & { Querystring: { rpc?: string } }>('/verify/:token', async (req) => {
      const link = await openProofLink(ctx, req.params.token, view(req, 'report'));
      const rpcUrl = req.query.rpc ? parse(z.string().url(), req.query.rpc) : undefined;
      return { ...(await verifyAsset(ctx, link.assetId, { rpcUrl })), linkExpiresAt: link.expiresAt };
    });
    app.get<P<'token' | 'eventId'>>('/verify/:token/events/:eventId/payload', async (req) => {
      const link = await openProofLink(ctx, req.params.token, view(req, `payload:${req.params.eventId}`));
      return eventPayload(ctx, link.assetId, Number(req.params.eventId));
    });
    app.get<P<'token'>>('/verify/:token/proof-pack', async (req, reply) => {
      const link = await openProofLink(ctx, req.params.token, view(req, 'proof-pack'));
      return reply
        .header('content-disposition', `attachment; filename="proof-pack-${link.assetId}.json"`)
        .send(await proofPack(ctx, link.assetId));
    });
  };
