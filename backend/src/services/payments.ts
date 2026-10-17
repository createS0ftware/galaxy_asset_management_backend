import { desc, gt, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { fromStroops } from '../lib/money.js';
import { kindName } from '../lib/payload.js';
import { usdcBalance } from './drivers.js';

/** Payments screen (§6.1): treasury, escrow held, fee-account XLM with alert. */
export async function paymentsSummary(ctx: Ctx) {
  const [treasury, feeAccount, trips, requested, payouts] = await Promise.all([
    usdcBalance(ctx, ctx.treasury.publicKey()),
    ctx.server.getAccountEntry(ctx.sub.fee.publicKey()),
    ctx.db.select().from(schema.trips).where(ne(schema.trips.status, 'closed')),
    ctx.db.select().from(schema.advances).where(inArray(schema.advances.status, ['requested'])),
    ctx.db.select().from(schema.custodyEvents).where(gt(schema.custodyEvents.amount, 0)).orderBy(desc(schema.custodyEvents.id)).limit(50),
  ]);
  const feeXlm = Number(feeAccount.balance) / 1e7;
  const held = trips.reduce((a, t) => a + BigInt(t.escrow - t.released), 0n);
  return {
    treasury: { address: ctx.treasury.publicKey(), usdc: fromStroops(treasury) },
    escrowHeld: fromStroops(held),
    feeAccount: {
      address: ctx.sub.fee.publicKey(),
      xlm: feeXlm.toFixed(7),
      alertThreshold: ctx.config.FEE_ALERT_XLM,
      alert: feeXlm < ctx.config.FEE_ALERT_XLM,
    },
    escrowByTrip: trips.map((t) => ({
      trip: t.id,
      status: t.status,
      funded: fromStroops(BigInt(t.escrow)),
      released: fromStroops(BigInt(t.released)),
      advances: fromStroops(BigInt(t.advanced)),
      left: fromStroops(BigInt(t.escrow - t.released)),
    })),
    advanceRequests: requested.map((a) => ({ ...a, amount: fromStroops(BigInt(a.amount)) })),
    recentPayouts: payouts.map((p) => ({
      trip: p.tripId,
      event: kindName(p.kind),
      wp: p.wp,
      amount: fromStroops(BigInt(p.amount)),
      txHash: p.txHash,
      at: p.ledgerTime,
    })),
  };
}

/** Reconciliation export from the indexed ledger events (what actually moved on-chain). */
export async function reconciliationCsv(ctx: Ctx) {
  const rows = await ctx.db.select().from(schema.ledgerEvents).orderBy(schema.ledgerEvents.ledger);
  const lines = ['ledger_time,ledger,tx_hash,topic,trip,to,kind,amount'];
  for (const r of rows.filter((r) => r.topic === 'payout')) {
    lines.push([r.ledgerTime.toISOString(), r.ledger, r.txHash, r.topic, r.tripId ?? '', r.to ?? '', kindName(r.kind ?? 0), fromStroops(BigInt(r.amount ?? 0))].join(','));
  }
  return lines.join('\n') + '\n';
}
