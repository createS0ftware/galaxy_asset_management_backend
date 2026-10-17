import { authorizeInvocation, Contract, inspectAuthEntry, Keypair, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { addr, bytes32, ChainAsset, ChainTrip, decodeAsset, decodeTrip, enumTuple, enumUnit, i128, str, u32, u64, vec } from './scval.js';
import type { AuthPlan, Submitter, TxResult } from './submitter.js';

/** Root invocation for `contractId.method(args)` with no sub-invocations. */
export function contractInvocation(contractId: string, method: string, args: xdr.ScVal[]): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Contract(contractId).address().toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: [],
  });
}

export type Resolution = { kind: 'resume' } | { kind: 'release'; pay: bigint };

/** Typed client for the `asset-trail` Soroban contract. */
export class TrailContract {
  private readonly contract: Contract;

  constructor(
    private readonly submitter: Submitter,
    readonly contractId: string,
  ) {
    this.contract = new Contract(contractId);
  }

  get passphrase() {
    return this.submitter.passphrase;
  }

  // ------------------------------------------------------------ arguments
  // One place that knows each function's argument order. Used both to build calls and to
  // check that a phone-signed auth entry authorizes exactly the call we are about to make.

  static args = {
    register_asset: (id: string, regHash: Buffer) => [str(id), bytes32(regHash)],
    activate_asset: (id: string, tagHash: Buffer) => [str(id), bytes32(tagHash)],
    create_trip: (t: {
      id: string;
      asset: string;
      driver: string;
      receiver: string;
      funder: string;
      legs: bigint[];
      advanceLimit: bigint;
      planHash: Buffer;
    }) => [
      str(t.id),
      str(t.asset),
      addr(t.driver),
      addr(t.receiver),
      addr(t.funder),
      vec(t.legs.map((l) => i128(l))),
      i128(t.advanceLimit),
      bytes32(t.planHash),
    ],
    check_in: (trip: string, wp: number, hash: Buffer) => [str(trip), u32(wp), bytes32(hash)],
    confirm_delivery: (trip: string, receiptHash: Buffer) => [str(trip), bytes32(receiptHash)],
    grant_advance: (trip: string, amount: bigint, expiresAt: number) => [str(trip), i128(amount), u64(expiresAt)],
    claim_advance: (trip: string) => [str(trip)],
    report_problem: (trip: string, by: string, evidenceHash: Buffer) => [str(trip), addr(by), bytes32(evidenceHash)],
    resolve_dispute: (trip: string, r: Resolution, reasonHash: Buffer) => [
      str(trip),
      r.kind === 'resume' ? enumUnit('Resume') : enumTuple('Release', i128(r.pay)),
      bytes32(reasonHash),
    ],
    force_check_in: (trip: string, wp: number, hash: Buffer, reasonHash: Buffer) => [
      str(trip),
      u32(wp),
      bytes32(hash),
      bytes32(reasonHash),
    ],
    log_override: (trip: string, reasonHash: Buffer) => [str(trip), bytes32(reasonHash)],
    cancel_trip: (trip: string, reasonHash: Buffer) => [str(trip), bytes32(reasonHash)],
    close_trip: (trip: string) => [str(trip)],
  };

  /** The root invocation a signer authorizes for `method(args)` (no sub-invocations). */
  invocation(method: string, args: xdr.ScVal[]): xdr.SorobanAuthorizedInvocation {
    return contractInvocation(this.contractId, method, args);
  }

  /** Sign an auth entry for `method(args)` with a key we hold (platform, receiver, …). */
  async sign(signer: Keypair, method: string, args: xdr.ScVal[], validUntilLedger: number): Promise<xdr.SorobanAuthorizationEntry> {
    return authorizeInvocation({
      signer,
      validUntilLedgerSeq: validUntilLedger,
      invocation: this.invocation(method, args),
      networkPassphrase: this.passphrase,
    });
  }

  /**
   * Check that an externally-signed entry authorizes exactly `method(args)` for `expectedSigner`
   * and is still valid. Signature validity itself is enforced by simulation and the network.
   */
  checkEntry(entry: xdr.SorobanAuthorizationEntry, expectedSigner: string, method: string, args: xdr.ScVal[], latestLedger: number) {
    const info = inspectAuthEntry(entry);
    if (info.address !== expectedSigner) return `entry is signed for ${info.address}, expected ${expectedSigner}`;
    if (!info.signed) return 'entry is not signed';
    if ((info.signatureExpirationLedger ?? 0) <= latestLedger) return 'entry has expired';
    if (!info.invocation.equals(this.invocation(method, args))) return `entry does not authorize this ${method} call`;
    return null;
  }

  call(method: string, args: xdr.ScVal[], plan: AuthPlan): Promise<TxResult> {
    return this.submitter.invoke(this.contractId, method, args, plan);
  }

  // ---------------------------------------------------------------- reads
  // Read straight from ledger state, no simulation needed.

  private async read(key: xdr.ScVal): Promise<xdr.ScVal | null> {
    try {
      const entry = await this.submitter.server.getContractData(this.contract, key, rpc.Durability.Persistent);
      if (entry.val.type !== 'contractData') return null;
      return entry.val.contractData.val;
    } catch (e) {
      if (/not found/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  async asset(id: string): Promise<ChainAsset | null> {
    const v = await this.read(vec([xdr.ScVal.scvSymbol('Asset'), str(id)]));
    return v ? decodeAsset(v) : null;
  }

  async trip(id: string): Promise<ChainTrip | null> {
    const v = await this.read(vec([xdr.ScVal.scvSymbol('Trip'), str(id)]));
    return v ? decodeTrip(v) : null;
  }

  async assetTrip(assetId: string, index: number): Promise<string | null> {
    const v = await this.read(vec([xdr.ScVal.scvSymbol('AssetTrip'), str(assetId), u32(index)]));
    return v ? String(scValToNative(v)) : null;
  }
}
