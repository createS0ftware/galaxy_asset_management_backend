import { asc, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { conflict, notFound, rejected } from '../lib/errors.js';
import { hashPayload, Kind, makePayload } from '../lib/payload.js';
import { TrailContract } from '../stellar/trail.js';
import { anchor } from './anchoring.js';

export interface RegisterAssetInput {
  id: string;
  name: string;
  type: string;
  serial: string;
  value?: string;
  tagId: string;
  documents?: { name: string; sha256: string }[];
}

/** Journey 5.1 stage 1 / T1: register the asset and anchor its registration payload. */
export async function registerAsset(ctx: Ctx, input: RegisterAssetInput, staffId: number) {
  const existing = await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, input.id) });
  if (existing) throw conflict('ASSET_EXISTS', `Asset ${input.id} already exists`);
  const docs = input.documents ?? [];
  const payload = makePayload('register', {
    asset: input.id,
    name: input.name,
    type: input.type,
    serial: input.serial,
    value: input.value ?? null,
    documents: docs.map((d) => ({ name: d.name, sha256: d.sha256 })),
  });
  await ctx.db.insert(schema.assets).values({
    id: input.id,
    name: input.name,
    type: input.type,
    serial: input.serial,
    value: input.value,
    tagId: input.tagId,
    regHash: hashPayload(payload).toString('hex'),
  });
  if (docs.length) await ctx.db.insert(schema.documents).values(docs.map((d) => ({ assetId: input.id, ...d })));
  try {
    const { event } = await anchor(ctx, { assetId: input.id, kind: Kind.REGISTER, payload, actor: `staff:${staffId}` }, async (hash) => {
      const tx = await ctx.trail.call('register_asset', TrailContract.args.register_asset(input.id, hash), {
        kind: 'record',
        signers: [ctx.admin],
      });
      return { tx, seq: 1 };
    });
    return { asset: await getAsset(ctx, input.id), event };
  } catch (e) {
    await ctx.db.delete(schema.custodyEvents).where(eq(schema.custodyEvents.assetId, input.id));
    await ctx.db.delete(schema.documents).where(eq(schema.documents.assetId, input.id));
    await ctx.db.delete(schema.assets).where(eq(schema.assets.id, input.id));
    throw e;
  }
}

/** BR-01: the asset goes live only after its tag is scanned and matches. */
export async function activateAsset(ctx: Ctx, id: string, scannedTag: string, staffId: number) {
  const asset = await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
  if (!asset) throw notFound('Asset');
  if (asset.status === 'active') throw conflict('ASSET_ALREADY_ACTIVE');
  if (scannedTag !== asset.tagId) throw rejected('TAG_MISMATCH', "Scanned tag doesn't match the tag registered for this asset");
  const payload = makePayload('activate', { asset: id, tag: scannedTag });
  const { event } = await anchor(ctx, { assetId: id, kind: Kind.ACTIVATE, payload, actor: `staff:${staffId}` }, async (hash) => {
    const tx = await ctx.trail.call('activate_asset', TrailContract.args.activate_asset(id, hash), ctx.signer.withAdmin(ctx.admin));
    return { tx, seq: 2 };
  });
  await ctx.db.update(schema.assets).set({ status: 'active', tagHash: event.hash }).where(eq(schema.assets.id, id));
  return { asset: await getAsset(ctx, id), event };
}

export async function getAsset(ctx: Ctx, id: string) {
  const asset = await ctx.db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
  if (!asset) throw notFound('Asset');
  const documents = await ctx.db.select().from(schema.documents).where(eq(schema.documents.assetId, id)).orderBy(asc(schema.documents.id));
  const trail = await ctx.db
    .select()
    .from(schema.custodyEvents)
    .where(eq(schema.custodyEvents.assetId, id))
    .orderBy(desc(schema.custodyEvents.id));
  return {
    ...asset,
    onChain: { contractId: ctx.trail.contractId, assetKey: id, sponsorship: 'Ledger entries paid by the platform' },
    documents: documents.map((d) => ({ ...d, anchoredAt: asset.createdAt })),
    trail,
  };
}

export async function listAssets(ctx: Ctx) {
  return ctx.db.select().from(schema.assets).orderBy(desc(schema.assets.createdAt));
}
