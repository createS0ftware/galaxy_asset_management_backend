import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import type { Ctx } from '../context.js';
import { unauthorized } from '../lib/errors.js';

export type Principal = { role: 'staff'; id: number } | { role: 'driver'; id: number };

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const key = (ctx: Ctx) => new TextEncoder().encode(ctx.config.JWT_SECRET);

export async function issueToken(ctx: Ctx, p: Principal, ttl = '12h') {
  return new SignJWT({ role: p.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(p.id))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(key(ctx));
}

async function principal(ctx: Ctx, req: FastifyRequest): Promise<Principal> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  try {
    const { payload } = await jwtVerify(h.slice(7), key(ctx));
    return { role: payload.role as Principal['role'], id: Number(payload.sub) };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

export const requireRole =
  (ctx: Ctx, role: Principal['role']) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    const p = await principal(ctx, req);
    if (p.role !== role) throw unauthorized(`${role} token required`);
    req.principal = p;
  };

export const who = (req: FastifyRequest) => req.principal!.id;
