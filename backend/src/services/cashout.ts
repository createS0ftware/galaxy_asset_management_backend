import { Memo, Operation, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk';
import { and, eq, inArray, like } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { badRequest, conflict, forbidden, notFound, rejected } from '../lib/errors.js';
import { fromStroops } from '../lib/money.js';
import { buildDriverTx } from '../stellar/accounts.js';
import { getDriver, usdcBalance } from './drivers.js';

/** Journey 5.2 stage 6: rate, fee, amount received and arrival time shown before Confirm. */
export async function quoteCashout(ctx: Ctx, driverId: number, amount: bigint) {
  const driver = await getDriver(ctx, driverId);
  if (driver.walletStatus !== 'ready' || !driver.publicKey) throw rejected('DRIVER_WALLET_NOT_READY');
  if (!driver.momoNumber) throw rejected('NO_MOMO', 'Link a mobile money number first');
  const balance = await usdcBalance(ctx, driver.publicKey);
  if (amount <= 0n || amount > balance) throw rejected('INSUFFICIENT_BALANCE', `Balance is ${fromStroops(balance)}`);
  const q = await ctx.anchor.quote(amount, driver.momoNumber);
  const { account, memo } = await ctx.anchor.withdrawInstructions(q);
  const [row] = await ctx.db
    .insert(schema.cashouts)
    .values({
      driverId,
      amount: Number(amount),
      quote: { ...q, sellAmount: q.sellAmount.toString(), fee: q.fee.toString() },
      destination: account,
      memo,
      status: 'quoted',
    })
    .returning();
  return {
    id: row!.id,
    youSend: fromStroops(amount),
    anchorFee: fromStroops(q.fee),
    rate: q.rate,
    youReceive: `${q.buyAmount} ${q.buyAsset.split(':')[1]}`,
    to: driver.momoNumber,
    arrival: q.arrival,
    validUntil: q.expiresAt,
    networkFee: 'paid by the platform',
    /** Anchor withdraw instructions, so the phone can check the payment it is later asked to sign. */
    payTo: account,
    memo,
  };
}

/**
 * BR-09: cash-out uses the driver's own sequence number, so it is blocked while any of the
 * driver's transactions are still queued.
 */
export async function prepareCashout(ctx: Ctx, driverId: number, cashoutId: number) {
  const c = await ctx.db.query.cashouts.findFirst({ where: eq(schema.cashouts.id, cashoutId) });
  if (!c) throw notFound('Cash-out');
  if (c.driverId !== driverId) throw forbidden();
  if (c.status !== 'quoted') throw conflict('CASHOUT_NOT_QUOTED');
  const q = c.quote as { expiresAt: string };
  if (new Date(q.expiresAt) < new Date()) throw rejected('QUOTE_EXPIRED');
  const busy = await ctx.db.query.custodyEvents.findFirst({
    where: and(like(schema.custodyEvents.actor, `driver:${driverId}`), inArray(schema.custodyEvents.status, ['pending', 'submitted'])),
  });
  if (busy) throw conflict('CHECKINS_PENDING', 'Wait until pending check-ins are recorded');

  const driver = await getDriver(ctx, driverId);
  const account = await ctx.server.getAccount(driver.publicKey!);
  const tx = buildDriverTx(
    account,
    ctx.sub.passphrase,
    [Operation.payment({ destination: c.destination, asset: ctx.usdc, amount: fromStroops(BigInt(c.amount)) })],
    Memo.text(c.memo),
  );
  await ctx.db.update(schema.cashouts).set({ status: 'prepared', innerXdr: tx.toXDR() }).where(eq(schema.cashouts.id, c.id));
  return { xdr: tx.toXDR(), networkPassphrase: ctx.sub.passphrase };
}

/** T9: driver-signed payment to the anchor, wrapped in a fee-bump paid by F. */
export async function submitCashout(ctx: Ctx, driverId: number, cashoutId: number, signedXdr: string) {
  const c = await ctx.db.query.cashouts.findFirst({ where: eq(schema.cashouts.id, cashoutId) });
  if (!c) throw notFound('Cash-out');
  if (c.driverId !== driverId) throw forbidden();
  if (c.status !== 'prepared' || !c.innerXdr) throw conflict('CASHOUT_NOT_PREPARED');
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, ctx.sub.passphrase) as Transaction;
  } catch {
    throw badRequest('BAD_XDR');
  }
  const prepared = TransactionBuilder.fromXDR(c.innerXdr, ctx.sub.passphrase) as Transaction;
  if (!Buffer.from(tx.hash()).equals(Buffer.from(prepared.hash()))) throw badRequest('TX_MISMATCH');
  await ctx.db.update(schema.cashouts).set({ status: 'submitted' }).where(eq(schema.cashouts.id, c.id));
  try {
    const res = await ctx.sub.feeBump(tx);
    const [row] = await ctx.db.update(schema.cashouts).set({ status: 'completed', txHash: res.txHash }).where(eq(schema.cashouts.id, c.id)).returning();
    return { ...row!, amount: fromStroops(BigInt(row!.amount)) };
  } catch (e) {
    await ctx.db.update(schema.cashouts).set({ status: 'failed', error: (e as Error).message }).where(eq(schema.cashouts.id, c.id));
    throw e;
  }
}
