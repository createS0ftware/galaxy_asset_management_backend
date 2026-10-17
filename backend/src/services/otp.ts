import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { otpCode, sha256Hex } from '../lib/crypto.js';

const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

export async function sendOtp(ctx: Ctx, phone: string, purpose: string, text: (code: string) => string) {
  const code = otpCode();
  await ctx.db.insert(schema.otpCodes).values({
    subject: phone,
    purpose,
    codeHash: sha256Hex(`${purpose}:${phone}:${code}`),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  await ctx.sms.send(phone, text(code));
}

/** Consume a valid OTP. Returns false on wrong, expired or exhausted codes. */
export async function checkOtp(ctx: Ctx, phone: string, purpose: string, code: string): Promise<boolean> {
  const t = schema.otpCodes;
  const [row] = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.subject, phone), eq(t.purpose, purpose), isNull(t.consumedAt), gt(t.expiresAt, new Date())))
    .orderBy(desc(t.id))
    .limit(1);
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;
  if (row.codeHash !== sha256Hex(`${purpose}:${phone}:${code}`)) {
    await ctx.db.update(t).set({ attempts: row.attempts + 1 }).where(eq(t.id, row.id));
    return false;
  }
  await ctx.db.update(t).set({ consumedAt: new Date() }).where(eq(t.id, row.id));
  return true;
}
