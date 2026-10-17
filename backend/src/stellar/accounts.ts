import { Account, Asset, BASE_FEE, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import type { Submitter, TxResult } from './submitter.js';

/** Parse "CODE:ISSUER". */
export function parseAsset(s: string): Asset {
  const [code, issuer] = s.split(':');
  return new Asset(code!, issuer!);
}

/**
 * Operations for an account created and fully sponsored by F (0 XLM starting balance), with an
 * optional sponsored trustline (§4.5). The account's own key must sign (it is the source of the
 * closing EndSponsoring op).
 */
export function sponsoredAccountOps(fee: string, account: string, trustline?: Asset) {
  return [
    Operation.beginSponsoringFutureReserves({ sponsoredId: account, source: fee }),
    Operation.createAccount({ destination: account, startingBalance: '0', source: fee }),
    ...(trustline ? [Operation.changeTrust({ asset: trustline, source: account })] : []),
    Operation.endSponsoringFutureReserves({ source: account }),
  ];
}

/** Create a sponsored account whose key we hold (custodial receivers). */
export function createSponsoredAccount(sub: Submitter, key: Keypair, trustline?: Asset): Promise<TxResult> {
  return sub.classic(sponsoredAccountOps(sub.fee.publicKey(), key.publicKey(), trustline), [key]);
}

/**
 * T2, step 1: build the driver-wallet transaction for the phone to sign. F's sequence is reserved
 * until `submit` or `ttlMs`, since the phone's signature binds the sequence number.
 */
export async function prepareDriverWallet(sub: Submitter, driver: string, usdc: Asset, ttlMs = 60_000) {
  const { source, release } = await sub.reserve(ttlMs);
  try {
    const b = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: sub.passphrase }).setTimeout(Math.floor(ttlMs / 1000));
    sponsoredAccountOps(sub.fee.publicKey(), driver, usdc).forEach((op) => b.addOperation(op));
    const tx = b.build();
    return { tx, release };
  } catch (e) {
    release(false);
    throw e;
  }
}

/** T2, step 2: add F's signature to the phone-signed transaction and submit it. */
export function submitDriverWallet(sub: Submitter, signed: Transaction): Promise<TxResult> {
  signed.sign(sub.fee);
  return sub.sendSigned(signed);
}

/** Build an inner transaction sourced by the driver (cash-out), to be fee-bumped by F. */
export function buildDriverTx(driver: Account, passphrase: string, ops: ReturnType<typeof Operation.payment>[], memo?: import('@stellar/stellar-sdk').Memo) {
  const b = new TransactionBuilder(driver, { fee: BASE_FEE, networkPassphrase: passphrase }).setTimeout(300);
  ops.forEach((op) => b.addOperation(op));
  if (memo) b.addMemo(memo);
  return b.build();
}
