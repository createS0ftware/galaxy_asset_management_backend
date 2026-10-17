/**
 * Phone-side helpers for the driver app (also used by tests and the demo script).
 * Everything here works offline: a check-in is a salted payload plus a Soroban auth entry signed
 * with the wallet key, authorizing exactly check_in(trip, wp, sha256(payload)).
 */
import { authorizeInvocation, Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { hashPayload, newSalt, type ReleasePayload, type WaypointPayload } from '../lib/payload.js';
import { contractInvocation, TrailContract } from '../stellar/trail.js';

export interface CheckInTemplate {
  contractId: string;
  networkPassphrase: string;
  wp: number;
  event: 'pickup' | 'checkin' | 'arrival';
  asset: string;
  latestLedger: number;
  ledgerSeconds: number;
  maxOfflineHours: number;
}

export function buildCheckInPayload(
  tripId: string,
  t: Pick<CheckInTemplate, 'wp' | 'event' | 'asset'>,
  fix: { tag: string; lat: number; lon: number; accM: number; photos?: string[]; at?: Date },
): WaypointPayload {
  return {
    v: 1,
    trip: tripId,
    wp: t.wp,
    event: t.event,
    asset: t.asset,
    tag: fix.tag,
    lat: fix.lat,
    lon: fix.lon,
    acc_m: fix.accM,
    t_device: (fix.at ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    photos: fix.photos ?? [],
    salt: newSalt(),
  };
}

/**
 * Valid-until ledger for an offline signature: the last ledger the phone saw, plus elapsed
 * time, plus the offline allowance (spec §4.4 `maxTime`).
 */
export function offlineValidUntil(t: Pick<CheckInTemplate, 'latestLedger' | 'ledgerSeconds' | 'maxOfflineHours'>, seenAt: Date, now = new Date()) {
  const elapsed = Math.max(0, Math.floor((now.getTime() - seenAt.getTime()) / 1000 / t.ledgerSeconds));
  return t.latestLedger + elapsed + Math.floor((t.maxOfflineHours * 3600) / t.ledgerSeconds);
}

async function signInvocation(key: Keypair, contractId: string, passphrase: string, method: string, args: ReturnType<typeof TrailContract.args.claim_advance>, validUntil: number) {
  const entry = await authorizeInvocation({
    signer: key,
    validUntilLedgerSeq: validUntil,
    invocation: contractInvocation(contractId, method, args),
    networkPassphrase: passphrase,
  });
  return entry.toXdr('base64');
}

export async function signCheckIn(key: Keypair, tripId: string, t: CheckInTemplate, payload: WaypointPayload, validUntil: number) {
  const args = TrailContract.args.check_in(tripId, payload.wp, hashPayload(payload));
  return { payload, authEntry: await signInvocation(key, t.contractId, t.networkPassphrase, 'check_in', args, validUntil) };
}

export function signClaimAdvance(key: Keypair, tripId: string, contractId: string, passphrase: string, validUntil: number) {
  return signInvocation(key, contractId, passphrase, 'claim_advance', TrailContract.args.claim_advance(tripId), validUntil);
}

/** The `finalPay` block of GET /driver/trips/:id while the trip awaits the receiver's signature. */
export interface FinalPayTemplate {
  contractId: string;
  networkPassphrase: string;
  latestLedger: number;
  ledgerSeconds: number;
  /** ISO time after which the driver can claim (null for trips created without one). */
  deadline: string | null;
  claimable: boolean;
  /** Final leg minus claimed advances. */
  amount: string;
}

export function buildReleasePayload(tripId: string, asset: string, at = new Date()): ReleasePayload {
  return {
    v: 1,
    event: 'release',
    trip: tripId,
    asset,
    t_device: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    salt: newSalt(),
  };
}

/** Sign claim_final_pay(trip, sha256(payload)): the body of POST /driver/trips/:id/final-pay. */
export async function signClaimFinalPay(
  key: Keypair,
  tripId: string,
  t: Pick<FinalPayTemplate, 'contractId' | 'networkPassphrase'>,
  payload: ReleasePayload,
  validUntil: number,
) {
  const args = TrailContract.args.claim_final_pay(tripId, hashPayload(payload));
  return { payload, authEntry: await signInvocation(key, t.contractId, t.networkPassphrase, 'claim_final_pay', args, validUntil) };
}

/** Sign a classic transaction the backend prepared (wallet onboarding, cash-out). */
export function signTransactionXdr(xdr: string, passphrase: string, key: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
  tx.sign(key);
  return tx.toXDR();
}
