import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { HttpError } from '../lib/errors.js';
import { ChainError } from '../stellar/submitter.js';
import { driverRoutes } from './routes/driver.js';
import { portalRoutes } from './routes/portal.js';
import { publicRoutes } from './routes/public.js';

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export async function buildApp(ctx: Ctx, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  app.setReplySerializer((payload) => JSON.stringify(payload, replacer));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ChainError) {
      if (err.contractError) {
        return reply.status(422).send({ error: `CONTRACT_${err.contractError}`, message: err.message });
      }
      req.log.error({ err: err.message, detail: err.detail }, 'chain error');
      return reply.status(502).send({ error: 'LEDGER_ERROR', message: err.message });
    }
    const e = err as { validation?: unknown; statusCode?: number; message: string; isAxiosError?: boolean; code?: string };
    if (e.isAxiosError || ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(e.code ?? '')) {
      ctx.log.error({ err: e.message, url: req.url }, 'ledger RPC unavailable');
      return reply.status(502).send({ error: 'LEDGER_UNAVAILABLE', message: 'Stellar RPC is unavailable, retry shortly' });
    }
    if (e.validation || (e.statusCode && e.statusCode < 500)) {
      return reply.status(e.statusCode ?? 400).send({ error: 'BAD_REQUEST', message: e.message });
    }
    ctx.log.error({ err: (err as Error).stack ?? String(err), url: req.url }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(publicRoutes(ctx), { prefix: '/v1' });
  await app.register(portalRoutes(ctx), { prefix: '/v1' });
  await app.register(driverRoutes(ctx), { prefix: '/v1/driver' });
  return app;
}
