import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { schema } from '../db/client.js';
import { canonical, hashPayload, type Payload } from '../lib/payload.js';
import type { TxResult } from '../stellar/submitter.js';

export interface AnchorInput {
  assetId: string;
  tripId?: string | null;
  kind: number;
  wp?: number;
  payload: Payload;
  auxPayload?: Payload | null;
  amount?: bigint;
  actor: string;
  deviceTime?: Date | null;
  offline?: boolean;
  authEntry?: string | null;
}

export type CustodyEvent = typeof schema.custodyEvents.$inferSelect;

/**
 * Record a custody event: store the payload (with salt) as pending, run the on-chain call with
 * its hash, then mark it confirmed with tx hash, ledger time and chain sequence — or failed.
 * `submit` returns the tx result and the chain sequence the contract assigned.
 */
export async function anchor(
  ctx: Ctx,
  input: AnchorInput,
  submit: (hash: Buffer, auxHash: Buffer | null) => Promise<{ tx: TxResult; seq: number }>,
): Promise<{ event: CustodyEvent; tx: TxResult }> {
  const hash = hashPayload(input.payload);
  const auxHash = input.auxPayload ? hashPayload(input.auxPayload) : null;
  const [row] = await ctx.db
    .insert(schema.custodyEvents)
    .values({
      assetId: input.assetId,
      tripId: input.tripId ?? null,
      kind: input.kind,
      wp: input.wp ?? 0,
      payload: canonical(input.payload),
      hash: hash.toString('hex'),
      auxPayload: input.auxPayload ? canonical(input.auxPayload) : null,
      auxHash: auxHash?.toString('hex') ?? null,
      amount: Number(input.amount ?? 0n),
      status: 'submitted',
      actor: input.actor,
      deviceTime: input.deviceTime ?? null,
      offline: input.offline ?? false,
      authEntry: input.authEntry ?? null,
    })
    .returning();
  try {
    const { tx, seq } = await submit(hash, auxHash);
    const [event] = await ctx.db
      .update(schema.custodyEvents)
      .set({ status: 'confirmed', txHash: tx.txHash, ledger: tx.ledger, ledgerTime: tx.ledgerTime, seq })
      .where(eq(schema.custodyEvents.id, row!.id))
      .returning();
    return { event: event!, tx };
  } catch (e) {
    await ctx.db
      .update(schema.custodyEvents)
      .set({ status: 'failed', error: String((e as Error).message).slice(0, 500) })
      .where(eq(schema.custodyEvents.id, row!.id));
    throw e;
  }
}
