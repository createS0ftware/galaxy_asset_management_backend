import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

// ------------------------------------------------------------------ encoders

export const str = (s: string) => nativeToScVal(s, { type: 'string' });
export const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
export const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: 'i128' });
export const bytes32 = (b: Buffer | Uint8Array) => {
  if (b.length !== 32) throw new Error('expected 32 bytes');
  return xdr.ScVal.scvBytes(Buffer.from(b));
};
export const addr = (a: string) => Address.fromString(a).toScVal();
export const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);
export const enumUnit = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
export const enumTuple = (name: string, v: xdr.ScVal) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), v]);

// ------------------------------------------------------------------ decoders

export type TripStatus = 'Funded' | 'InTransit' | 'AwaitingSignature' | 'Disputed' | 'Delivered' | 'Cancelled' | 'Closed';

export interface ChainRecord {
  kind: number;
  wp: number;
  hash: Buffer;
  aux: Buffer | null;
  amount: bigint;
  ledger: number;
  timestamp: number;
  seq: number;
}

export interface ChainAsset {
  id: string;
  regHash: Buffer;
  tagHash: Buffer | null;
  active: boolean;
  head: Buffer;
  seq: number;
  currentTrip: string | null;
  tripCount: number;
}

export interface ChainTrip {
  id: string;
  asset: string;
  driver: string;
  receiver: string;
  funder: string;
  legs: bigint[];
  advanceLimit: bigint;
  planHash: Buffer;
  funded: bigint;
  released: bigint;
  advanced: bigint;
  pendingAdvance: bigint;
  advanceExpiresAt: number;
  nextWp: number;
  status: TripStatus;
  records: ChainRecord[];
}

type Raw = Record<string, any>;
const buf = (v: unknown): Buffer => Buffer.from(v as Uint8Array);
const optBuf = (v: unknown): Buffer | null => (v === undefined || v === null ? null : buf(v));

export function decodeRecord(r: Raw): ChainRecord {
  return {
    kind: Number(r.kind),
    wp: Number(r.wp),
    hash: buf(r.hash),
    aux: optBuf(r.aux),
    amount: BigInt(r.amount),
    ledger: Number(r.ledger),
    timestamp: Number(r.timestamp),
    seq: Number(r.seq),
  };
}

export function decodeAsset(v: xdr.ScVal): ChainAsset {
  const r: Raw = scValToNative(v);
  return {
    id: r.id,
    regHash: buf(r.reg_hash),
    tagHash: optBuf(r.tag_hash),
    active: Boolean(r.active),
    head: buf(r.head),
    seq: Number(r.seq),
    currentTrip: r.current_trip ?? null,
    tripCount: Number(r.trip_count),
  };
}

export function decodeTrip(v: xdr.ScVal): ChainTrip {
  const r: Raw = scValToNative(v);
  return {
    id: r.id,
    asset: r.asset,
    driver: r.driver,
    receiver: r.receiver,
    funder: r.funder,
    legs: (r.legs as unknown[]).map((x) => BigInt(x as bigint)),
    advanceLimit: BigInt(r.advance_limit),
    planHash: buf(r.plan_hash),
    funded: BigInt(r.funded),
    released: BigInt(r.released),
    advanced: BigInt(r.advanced),
    pendingAdvance: BigInt(r.pending_advance),
    advanceExpiresAt: Number(r.advance_expires_at),
    nextWp: Number(r.next_wp),
    status: (Array.isArray(r.status) ? r.status[0] : r.status) as TripStatus,
    records: (r.records as Raw[]).map(decodeRecord),
  };
}

/** Contract error codes, identical to `contracts/asset-trail/src/types.rs`. */
export const CONTRACT_ERRORS: Record<number, string> = {
  1: 'InvalidId',
  2: 'AssetExists',
  3: 'AssetNotFound',
  4: 'AssetInactive',
  5: 'AssetBusy',
  6: 'AssetAlreadyActive',
  7: 'TripExists',
  8: 'TripNotFound',
  9: 'InvalidLegs',
  10: 'InvalidAmount',
  11: 'WrongStatus',
  12: 'WrongWaypoint',
  14: 'AdvanceOverCap',
  15: 'AdvancePending',
  16: 'NoAdvance',
  17: 'AdvanceExpired',
  18: 'NotReceiverOrPlatform',
  19: 'PayOverRemaining',
  20: 'InvalidDeadline',
};
