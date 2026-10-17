import { Keypair, StrKey, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { prepareDriverWallet, submitDriverWallet } from '../stellar/accounts.js';

export type Driver = typeof schema.drivers.$inferSelect;

export async function createDriver(ctx: Ctx, input: { phone: string; name: string; momoNumber?: string }) {
  const existing = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.phone, input.phone) });
  if (existing) throw conflict('DRIVER_EXISTS');
  const [row] = await ctx.db.insert(schema.drivers).values(input).returning();
  return row!;
}

export async function getDriver(ctx: Ctx, id: number): Promise<Driver> {
  const d = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.id, id) });
  if (!d) throw notFound('Driver');
  return d;
}

export const listDrivers = (ctx: Ctx) => ctx.db.select().from(schema.drivers).orderBy(schema.drivers.id);

/** Sequence reservations for onboarding txs waiting for the phone's signature. */
const pending = new Map<number, { hash: string; release: (sent: boolean) => void; timer: NodeJS.Timeout }>();

/**
 * Journey 5.2 stage 1 / T2, step 1. The phone generated its key in secure hardware and sends the
 * public key; we return the sponsored account + USDC trustline tx for it to sign.
 */
export async function prepareWallet(ctx: Ctx, driverId: number, publicKey: string) {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) throw badRequest('BAD_PUBLIC_KEY');
  const driver = await getDriver(ctx, driverId);
  if (driver.walletStatus === 'ready') throw conflict('WALLET_READY');
  const other = await ctx.db.query.drivers.findFirst({ where: eq(schema.drivers.publicKey, publicKey) });
  if (other && other.id !== driverId) throw conflict('KEY_IN_USE');
  pending.get(driverId)?.release(false);

  const ttlMs = 60_000;
  const { tx, release } = await prepareDriverWallet(ctx.sub, publicKey, ctx.usdc, ttlMs);
  const hash = Buffer.from(tx.hash()).toString('hex');
  const timer = setTimeout(() => pending.delete(driverId), ttlMs);
  pending.set(driverId, { hash, release, timer });
  await ctx.db
    .update(schema.drivers)
    .set({ publicKey, walletStatus: 'pending', pendingWalletXdr: tx.toXDR() })
    .where(eq(schema.drivers.id, driverId));
  return { xdr: tx.toXDR(), hash, networkPassphrase: ctx.sub.passphrase, expiresInSeconds: ttlMs / 1000 };
}

/** T2, step 2: the phone returns the signed tx; F co-signs and submits. */
export async function submitWallet(ctx: Ctx, driverId: number, signedXdr: string) {
  const driver = await getDriver(ctx, driverId);
  const slot = pending.get(driverId);
  if (!slot || !driver.publicKey) throw conflict('NO_PENDING_WALLET', 'Prepare the wallet again');
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, ctx.sub.passphrase) as Transaction;
  } catch {
    throw badRequest('BAD_XDR');
  }
  if (Buffer.from(tx.hash()).toString('hex') !== slot.hash) throw badRequest('TX_MISMATCH', 'Signed transaction differs from the prepared one');
  const kp = Keypair.fromPublicKey(driver.publicKey);
  const signed = tx.signatures.some((s) => kp.verify(Buffer.from(tx.hash()), Buffer.from(s.signature.toBytes())));
  if (!signed) throw badRequest('NOT_SIGNED', 'Missing the wallet key signature');

  clearTimeout(slot.timer);
  pending.delete(driverId);
  try {
    const res = await submitDriverWallet(ctx.sub, tx);
    slot.release(true);
    await ctx.db
      .update(schema.drivers)
      .set({ walletStatus: 'ready', pendingWalletXdr: null, walletTx: res.txHash })
      .where(eq(schema.drivers.id, driverId));
    return { address: driver.publicKey, txHash: res.txHash };
  } catch (e) {
    slot.release(true); // the sequence may have been consumed; the submitter refetches on error
    throw e;
  }
}

/** USDC balance of a G account (stroops). */
export async function usdcBalance(ctx: Ctx, account: string): Promise<bigint> {
  try {
    const tl = await ctx.server.getTrustline(account, ctx.usdc);
    return BigInt(tl.balance);
  } catch {
    return 0n;
  }
}
