import { createHash, randomBytes } from 'node:crypto';
import canonicalize from 'canonicalize';

/**
 * Off-chain payloads (§4.2). Each one is canonicalised with RFC 8785 (JCS) and hashed with
 * SHA-256; only the digest goes on the ledger. Every payload carries a 32-byte random salt so
 * the public hash can't be brute-forced from guessed coordinates and times (BR-08).
 */
export type Payload = { v: 1; event: string; salt: string } & Record<string, unknown>;

export const newSalt = () => randomBytes(32).toString('base64');

export function canonical(payload: Payload): string {
  const s = canonicalize(payload);
  if (s === undefined) throw new Error('Payload cannot be canonicalised');
  return s;
}

export function hashPayload(payload: Payload): Buffer {
  if (typeof payload.salt !== 'string' || Buffer.from(payload.salt, 'base64').length !== 32) {
    throw new Error('Payload salt must be 32 random bytes, base64');
  }
  return createHash('sha256').update(canonical(payload)).digest();
}

/** Build a server-side payload with a fresh salt. */
export function makePayload<T extends Record<string, unknown>>(event: string, body: T): Payload & T {
  return { v: 1, event, ...body, salt: newSalt() } as Payload & T;
}

/** The waypoint check-in payload built on the driver's phone (§4.2 example). */
export interface WaypointPayload extends Payload {
  event: 'pickup' | 'checkin' | 'arrival';
  trip: string;
  wp: number;
  asset: string;
  tag: string;
  lat: number;
  lon: number;
  acc_m: number;
  t_device: string;
  photos: string[];
}

/**
 * The final-pay release payload built on the driver's phone once the delivery deadline has passed
 * with no receiver signature or dispute (§4.6). Its hash is the `claim_hash` of claim_final_pay.
 */
export interface ReleasePayload extends Payload {
  event: 'release';
  trip: string;
  asset: string;
  t_device: string;
}

/** Custody-chain step, mirroring the contract: sha256(head ‖ kind_be32 ‖ hash ‖ aux|zeros). */
export function chainStep(head: Buffer, kind: number, hash: Buffer, aux?: Buffer | null): Buffer {
  const k = Buffer.alloc(4);
  k.writeUInt32BE(kind);
  return createHash('sha256')
    .update(Buffer.concat([head, k, hash, aux ?? Buffer.alloc(32)]))
    .digest();
}

/** Custody kinds, identical to `contracts/asset-trail/src/types.rs`. */
export const Kind = {
  REGISTER: 1,
  ACTIVATE: 2,
  DISPATCH: 3,
  PICKUP: 4,
  CHECKIN: 5,
  ARRIVAL: 6,
  DELIVERY: 7,
  DISPUTE: 8,
  RESOLVE: 9,
  OVERRIDE: 10,
  FORCED_CHECKIN: 11,
  CANCEL: 12,
  ADVANCE: 13,
  REFUND: 14,
  /** Final leg released to the driver after the delivery deadline (custody kind). */
  RELEASE: 15,
} as const;
export type KindName = keyof typeof Kind;
export const kindName = (k: number) => (Object.keys(Kind) as KindName[]).find((n) => Kind[n] === k) ?? `UNKNOWN_${k}`;
