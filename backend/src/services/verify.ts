import { createHash } from 'node:crypto';
import { rpc } from '@stellar/stellar-sdk';
import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { chainStep, Kind, kindName } from '../lib/payload.js';
import { Submitter } from '../stellar/submitter.js';
import { TrailContract } from '../stellar/trail.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Who the contract requires to authorize each kind (enforced on-chain by require_auth). */
const REQUIRED_SIGNERS: Record<number, string[]> = {
  [Kind.REGISTER]: ['admin'],
  [Kind.ACTIVATE]: ['admin', 'platform'],
  [Kind.DISPATCH]: ['admin', 'treasury'],
  [Kind.PICKUP]: ['driver', 'platform'],
  [Kind.CHECKIN]: ['driver', 'platform'],
  [Kind.ARRIVAL]: ['driver', 'platform'],
  [Kind.DELIVERY]: ['receiver', 'platform'],
  [Kind.DISPUTE]: ['receiver or platform'],
  [Kind.RESOLVE]: ['admin'],
  [Kind.OVERRIDE]: ['admin'],
  [Kind.FORCED_CHECKIN]: ['admin', 'platform'],
  [Kind.CANCEL]: ['admin'],
};

// ------------------------------------------------------------ proof links

/** Journey 5.4 stage 1: one asset per link, time-limited, views logged. */
export async function createProofLink(ctx: Ctx, assetId: string, staffId: number, days = ctx.config.PROOF_LINK_DAYS, note?: string) {
  const asset = await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, assetId) });
  if (!asset) throw notFound('Asset');
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  await ctx.db.insert(schema.proofLinks).values({ token, assetId, createdBy: staffId, expiresAt, note });
  return { url: `${ctx.config.PUBLIC_BASE_URL}/verify/${token}`, token, expiresAt };
}

export async function openProofLink(ctx: Ctx, token: string, view: { ip?: string; userAgent?: string; what: string }) {
  const link = await ctx.db.query.proofLinks.findFirst({ where: eq(schema.proofLinks.token, token) });
  if (!link) throw notFound('Proof link');
  if (link.revokedAt || link.expiresAt < new Date()) throw new HttpError(410, 'LINK_EXPIRED', 'This proof link has expired');
  await ctx.db.insert(schema.proofLinkViews).values({ linkId: link.id, ip: view.ip, userAgent: view.userAgent, what: view.what });
  return link;
}

// ------------------------------------------------------------ verification

interface ChainRow {
  seq: number;
  kind: number;
  trip: string | null;
  wp: number;
  hash: string;
  aux: string | null;
  amount: string;
  ledger: number | null;
  ledgerTime: Date | null;
}

async function readChain(trail: TrailContract, assetId: string) {
  const asset = await trail.asset(assetId);
  if (!asset) return null;
  const rows: ChainRow[] = [
    { seq: 1, kind: Kind.REGISTER, trip: null, wp: 0, hash: asset.regHash.toString('hex'), aux: null, amount: '0', ledger: null, ledgerTime: null },
  ];
  if (asset.tagHash) {
    rows.push({ seq: 2, kind: Kind.ACTIVATE, trip: null, wp: 0, hash: asset.tagHash.toString('hex'), aux: null, amount: '0', ledger: null, ledgerTime: null });
  }
  const trips = [];
  for (let i = 0; i < asset.tripCount; i++) {
    const id = await trail.assetTrip(assetId, i);
    const t = id ? await trail.trip(id) : null;
    if (!t) continue;
    trips.push(t);
    for (const r of t.records) {
      rows.push({
        seq: r.seq,
        kind: r.kind,
        trip: t.id,
        wp: r.wp,
        hash: r.hash.toString('hex'),
        aux: r.aux?.toString('hex') ?? null,
        amount: r.amount.toString(),
        ledger: r.ledger,
        ledgerTime: new Date(r.timestamp * 1000),
      });
    }
  }
  rows.sort((a, b) => a.seq - b.seq);
  return { asset, trips, rows };
}

/**
 * Journey 5.4 stages 2–4: re-hash every stored payload, compare with the on-chain record,
 * recompute the custody hash chain and flag gaps. `rpcUrl` lets the auditor use their own node.
 */
export async function verifyAsset(ctx: Ctx, assetId: string, opts: { rpcUrl?: string } = {}) {
  const trail = opts.rpcUrl
    ? new TrailContract(new Submitter(new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') }), ctx.sub.passphrase, ctx.sub.fee), ctx.trail.contractId)
    : ctx.trail;
  const chain = await readChain(trail, assetId);
  if (!chain) throw notFound('Asset on ledger');
  const offchain = await ctx.db
    .select()
    .from(schema.custodyEvents)
    .where(and(eq(schema.custodyEvents.assetId, assetId), eq(schema.custodyEvents.status, 'confirmed')))
    .orderBy(asc(schema.custodyEvents.seq));

  const gapLimit = ctx.config.OFFLINE_GAP_FLAG_SECONDS;
  const flags: { seq: number; type: string; detail: string }[] = [];
  const rows = chain.rows.map((rec) => {
    const ev = offchain.find((e) => e.seq === rec.seq);
    const payloadHash = ev ? sha(ev.payload) : null;
    const auxHash = ev?.auxPayload ? sha(ev.auxPayload) : null;
    const result = !ev ? 'Missing' : payloadHash === rec.hash && auxHash === rec.aux ? 'Match' : 'Mismatch';
    const ledgerTime = rec.ledgerTime ?? ev?.ledgerTime ?? null;
    if (ev?.deviceTime && ledgerTime) {
      const gap = Math.round((ledgerTime.getTime() - ev.deviceTime.getTime()) / 1000);
      if (gap > gapLimit) flags.push({ seq: rec.seq, type: 'offline_gap', detail: `Recorded ${gap}s after device time (limit ${gapLimit}s)` });
    }
    if (rec.kind === Kind.FORCED_CHECKIN || rec.kind === Kind.OVERRIDE) flags.push({ seq: rec.seq, type: 'override', detail: kindName(rec.kind) });
    if (rec.kind === Kind.DISPUTE) flags.push({ seq: rec.seq, type: 'dispute', detail: 'Problem reported' });
    if (result !== 'Match') flags.push({ seq: rec.seq, type: result.toLowerCase(), detail: `Payload ${result.toLowerCase()}` });
    return {
      seq: rec.seq,
      event: kindName(rec.kind),
      trip: rec.trip,
      wp: rec.wp,
      place: null as string | null,
      deviceTime: ev?.deviceTime ?? null,
      ledgerTime,
      signers: REQUIRED_SIGNERS[rec.kind] ?? [],
      payloadHash,
      onChainHash: rec.hash,
      onChainAux: rec.aux,
      amount: rec.amount,
      result,
      txHash: ev?.txHash ?? null,
      offline: ev?.offline ?? false,
      eventId: ev?.id ?? null,
    };
  });
  // Off-chain records claiming confirmation but absent on-chain.
  for (const ev of offchain) {
    if (!chain.rows.some((r) => r.seq === ev.seq)) flags.push({ seq: ev.seq ?? -1, type: 'missing_on_chain', detail: `Event ${ev.id} not on ledger` });
  }

  let head: Buffer = Buffer.alloc(32);
  for (const r of chain.rows) head = chainStep(head, r.kind, Buffer.from(r.hash, 'hex'), r.aux ? Buffer.from(r.aux, 'hex') : null);
  const chainIntact = head.equals(chain.asset.head) && chain.rows.length === chain.asset.seq;

  // Place names from the route plan for display.
  for (const row of rows) {
    if (row.trip) {
      const w = await ctx.db.query.waypoints.findFirst({ where: and(eq(schema.waypoints.tripId, row.trip), eq(schema.waypoints.idx, row.wp)) });
      row.place = w?.name ?? null;
    }
  }

  const matched = rows.filter((r) => r.result === 'Match').length;
  return {
    asset: assetId,
    contractId: ctx.trail.contractId,
    dataSource: opts.rpcUrl ?? ctx.config.STELLAR_RPC_URL,
    network: ctx.sub.passphrase,
    chain: { head: chain.asset.head.toString('hex'), seq: chain.asset.seq, intact: chainIntact },
    trips: chain.trips.map((t) => ({ id: t.id, status: t.status, funded: t.funded.toString(), released: t.released.toString() })),
    summary: `${matched} of ${rows.length} hashes match`,
    matched,
    total: rows.length,
    flagCount: flags.length,
    flags,
    rows,
  };
}

/** "View payload" — only through a proof link (BR-08: salts are released only this way). */
export async function eventPayload(ctx: Ctx, assetId: string, eventId: number) {
  const ev = await ctx.db.query.custodyEvents.findFirst({
    where: and(eq(schema.custodyEvents.id, eventId), eq(schema.custodyEvents.assetId, assetId)),
  });
  if (!ev) throw notFound('Event');
  return { id: ev.id, payload: JSON.parse(ev.payload), canonical: ev.payload, hash: ev.hash, auxPayload: ev.auxPayload && JSON.parse(ev.auxPayload) };
}

/** Journey 5.4 stage 5: everything needed to verify without us. */
export async function proofPack(ctx: Ctx, assetId: string) {
  const report = await verifyAsset(ctx, assetId);
  const events = await ctx.db
    .select()
    .from(schema.custodyEvents)
    .where(and(eq(schema.custodyEvents.assetId, assetId), eq(schema.custodyEvents.status, 'confirmed')))
    .orderBy(asc(schema.custodyEvents.seq));
  return {
    format: 'asset-trail-proof-pack/v1',
    generatedAt: new Date().toISOString(),
    network: ctx.sub.passphrase,
    rpcUrl: ctx.config.STELLAR_RPC_URL,
    contractId: ctx.trail.contractId,
    asset: assetId,
    chain: report.chain,
    summary: report.summary,
    flags: report.flags,
    hashing: 'sha256(RFC 8785 canonical JSON); chain: sha256(head ‖ kind_be32 ‖ hash ‖ aux|32×0), genesis 32×0',
    events: events.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      event: kindName(e.kind),
      trip: e.tripId,
      wp: e.wp,
      payload: e.payload,
      hash: e.hash,
      auxPayload: e.auxPayload,
      auxHash: e.auxHash,
      txHash: e.txHash,
      ledger: e.ledger,
      ledgerTime: e.ledgerTime,
      deviceTime: e.deviceTime,
    })),
    verifier: 'verifier/verify.mjs — node verify.mjs proof-pack.json [--rpc <url>]',
  };
}
