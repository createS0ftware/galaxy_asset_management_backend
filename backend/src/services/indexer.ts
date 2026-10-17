import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';

const CURSOR = 'indexer_cursor';

/**
 * Reads the contract's events from Stellar RPC into `ledger_events` and reconciles them with
 * `custody_events`. RPC keeps events for a limited window, so run it continuously; the
 * contract's own storage (records + hash chain) remains the long-term source of truth.
 */
/** Ledger sequence encoded in an RPC event cursor (TOID: ledger << 32 | …). */
const cursorLedger = (c: string) => Number(BigInt(c.split('-')[0]!) >> 32n);

/**
 * One indexing pass. RPC scans a bounded ledger range per request and returns a cursor, so we
 * page until the cursor reaches the latest ledger.
 */
export async function indexOnce(ctx: Ctx, maxPages = 50): Promise<number> {
  const filters = [{ type: 'contract' as const, contractIds: [ctx.trail.contractId] }];
  let n = 0;
  for (let page = 0; page < maxPages; page++) {
    const kv = await ctx.db.query.kv.findFirst({ where: eq(schema.kv.key, CURSOR) });
    const res = kv
      ? await ctx.server.getEvents({ cursor: kv.value, filters, limit: 200 })
      : await ctx.server.getEvents({ startLedger: Math.max(1, (await ctx.sub.latestLedger()) - 17_000), filters, limit: 200 });
    for (const ev of res.events) n += await storeEvent(ctx, ev);
    await ctx.db.insert(schema.kv).values({ key: CURSOR, value: res.cursor }).onConflictDoUpdate({ target: schema.kv.key, set: { value: res.cursor } });
    if (res.events.length < 200 && cursorLedger(res.cursor) >= res.latestLedger) break;
  }
  return n;
}

async function storeEvent(ctx: Ctx, ev: rpc.Api.EventResponse): Promise<number> {
  const topic = ev.topic.map((t) => scValToNative(t));
  const name = String(topic[0]);
  const data = scValToNative(ev.value) as Record<string, unknown>;
  const hex = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : null);
  const row = {
    id: ev.id,
    ledger: ev.ledger,
    ledgerTime: new Date(ev.ledgerClosedAt),
    txHash: ev.txHash,
    topic: name,
    assetId: name === 'custody' ? String(topic[1]) : null,
    tripId: name === 'custody' ? String(topic[2]) || null : String(topic[1]),
    to: name === 'payout' ? String(topic[2]) : null,
    kind: data.kind !== undefined ? Number(data.kind) : null,
    seq: data.seq !== undefined ? Number(data.seq) : null,
    hash: hex(data.hash),
    head: hex(data.head),
    amount: data.amount !== undefined ? Number(data.amount) : null,
    data: JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))),
  };
  const inserted = await ctx.db.insert(schema.ledgerEvents).values(row).onConflictDoNothing().returning();
  if (inserted.length && name === 'custody' && row.hash) {
    const local = await ctx.db.query.custodyEvents.findFirst({ where: eq(schema.custodyEvents.hash, row.hash) });
    if (!local) ctx.log.warn({ seq: row.seq, asset: row.assetId, tx: row.txHash }, 'on-chain custody event with no local payload');
    else if (local.status !== 'confirmed') {
      await ctx.db
        .update(schema.custodyEvents)
        .set({ status: 'confirmed', txHash: row.txHash, ledger: row.ledger, ledgerTime: row.ledgerTime, seq: row.seq })
        .where(eq(schema.custodyEvents.id, local.id));
    }
  }
  return inserted.length;
}

export function startIndexer(ctx: Ctx): () => void {
  if (!ctx.config.INDEXER_INTERVAL_MS) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await indexOnce(ctx);
    } catch (e) {
      ctx.log.error({ err: (e as Error).message }, 'indexer');
    } finally {
      running = false;
    }
  }, ctx.config.INDEXER_INTERVAL_MS);
  return () => clearInterval(timer);
}
