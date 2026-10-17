import { Keypair } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { createSponsoredAccount } from '../stellar/accounts.js';

export type Receiver = typeof schema.receivers.$inferSelect;

/**
 * Decision D1, option B: each receiver phone gets a platform-custodied ed25519 account
 * (sponsored, 0 XLM), unlocked only by an SMS OTP at signing time. The contract just sees an
 * Address, so a passkey smart wallet (option A) can replace this without contract changes.
 */
export async function getOrCreateReceiver(ctx: Ctx, phone: string, name?: string): Promise<Receiver> {
  const existing = await ctx.db.query.receivers.findFirst({ where: eq(schema.receivers.phone, phone) });
  if (existing) return existing;
  const kp = Keypair.random();
  await createSponsoredAccount(ctx.sub, kp);
  const [row] = await ctx.db
    .insert(schema.receivers)
    .values({ phone, name, publicKey: kp.publicKey(), secretEnc: encryptSecret(kp.secret(), ctx.config.RECEIVER_KEY_ENCRYPTION_KEY) })
    .returning();
  return row!;
}

export function receiverKey(ctx: Ctx, r: Receiver): Keypair {
  return Keypair.fromSecret(decryptSecret(r.secretEnc, ctx.config.RECEIVER_KEY_ENCRYPTION_KEY));
}
