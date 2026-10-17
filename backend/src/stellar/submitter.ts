import {
  Account,
  Address,
  authorizeEntry,
  Contract,
  inspectAuthEntry,
  StrKey,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { CONTRACT_ERRORS } from './scval.js';

export class ChainError extends Error {
  constructor(
    message: string,
    readonly contractError?: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface TxResult {
  txHash: string;
  ledger: number;
  ledgerTime: Date;
  returnValue?: xdr.ScVal;
}

/**
 * How the auth entries of a contract call get signed:
 * - `record`: simulate in recording mode, then sign every entry with the matching platform key.
 * - `entries`: the complete, already-signed set (e.g. the driver's phone-signed entry plus the
 *   platform co-signature). Simulated in enforcing mode, so bad signatures fail before submit.
 */
export type AuthPlan = { kind: 'record'; signers: Keypair[] } | { kind: 'entries'; entries: xdr.SorobanAuthorizationEntry[] };

const AUTH_VALIDITY_LEDGERS = 100;

export function parseContractError(text: string): string | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(text);
  return m ? (CONTRACT_ERRORS[Number(m[1])] ?? `Contract#${m[1]}`) : undefined;
}

/**
 * Submits transactions with the fee account F as source (§4.5). F's sequence number is tracked
 * locally and every F-sourced send is serialised, so concurrent requests don't collide.
 * Single-process only; scale out with channel accounts.
 */
export class Submitter {
  private account: Account | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly server: rpc.Server,
    readonly passphrase: string,
    readonly fee: Keypair,
  ) {}

  /** Run `fn` with exclusive use of F's sequence number. */
  serial<T>(fn: (source: Account) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.account) this.account = await this.server.getAccount(this.fee.publicKey());
      try {
        return await fn(this.account);
      } catch (e) {
        this.account = null; // refetch: the local sequence may have advanced without a send
        throw e;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Hold F's sequence for an externally-signed tx (driver onboarding). Other F transactions
   * wait until `release` is called or `ttlMs` elapses.
   */
  reserve(ttlMs: number): Promise<{ source: Account; release: (sent: boolean) => void }> {
    return new Promise((outer, fail) => {
      this.serial(
        (source) =>
          new Promise<void>((done, abort) => {
            const timer = setTimeout(() => abort(new Error('reservation expired')), ttlMs);
            outer({
              source,
              release: (sent) => {
                clearTimeout(timer);
                if (sent) done();
                else abort(new Error('reservation released unused'));
              },
            });
          }),
      ).catch((e) => {
        if (!String(e?.message).startsWith('reservation')) fail(e);
      });
    });
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  private build(source: Account, op: xdr.Operation): Transaction {
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.passphrase })
      .addOperation(op)
      .setTimeout(120)
      .build();
  }

  private async simulate(op: xdr.Operation, mode: 'record' | 'enforce') {
    const dummy = new Account(this.fee.publicKey(), '0');
    const sim = await this.server.simulateTransaction(this.build(dummy, op), undefined, mode);
    if (rpc.Api.isSimulationError(sim)) {
      const ce = parseContractError(sim.error);
      throw new ChainError(ce ? `Contract error: ${ce}` : `Simulation failed: ${sim.error.split('\n')[0]}`, ce, sim.error);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new ChainError('Ledger entries are archived and need a restore before this call');
    }
    return sim;
  }

  /** Invoke a contract function; returns once the transaction is in a closed ledger. */
  invoke(contractId: string, method: string, args: xdr.ScVal[], plan: AuthPlan): Promise<TxResult> {
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Contract(contractId).address().toScAddress(),
        functionName: method,
        args,
      }),
    );
    return this.host(func, plan);
  }

  /** Host function taken from an SDK-built operation (upload Wasm, deploy contract, SAC). */
  hostFromOp(op: xdr.Operation, plan: AuthPlan = { kind: 'record', signers: [] }): Promise<TxResult> {
    const body = op.body as unknown as { invokeHostFunctionOp: xdr.InvokeHostFunctionOp };
    return this.host(body.invokeHostFunctionOp.hostFunction, plan);
  }

  async host(func: xdr.HostFunction, plan: AuthPlan): Promise<TxResult> {
    let entries: xdr.SorobanAuthorizationEntry[];
    if (plan.kind === 'record') {
      const rec = await this.simulate(Operation.invokeHostFunction({ func, auth: [] }), 'record');
      const until = rec.latestLedger + AUTH_VALIDITY_LEDGERS;
      entries = await Promise.all(
        (rec.result?.auth ?? []).map(async (entry) => {
          const who = inspectAuthEntry(entry).address;
          if (who === null) return entry; // source-account credentials: covered by F's tx signature
          const kp = plan.signers.find((k) => k.publicKey() === who);
          if (!kp) throw new ChainError(`No platform key for required signer ${who}`);
          return authorizeEntry(entry, kp, until, this.passphrase);
        }),
      );
    } else {
      entries = plan.entries;
    }
    const op = Operation.invokeHostFunction({ func, auth: entries });
    const sim = await this.simulate(op, 'enforce');
    const hash = await this.serial(async (source) => {
      const tx = rpc.assembleTransaction(this.build(source, op), sim).build();
      tx.sign(this.fee);
      return this.send(tx);
    });
    return this.poll(hash);
  }

  /** Build, sign and send an F-sourced classic transaction. */
  async classic(ops: xdr.Operation[], extraSigners: Keypair[] = []): Promise<TxResult> {
    const hash = await this.serial(async (source) => {
      const b = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.passphrase }).setTimeout(120);
      ops.forEach((o) => b.addOperation(o));
      const tx = b.build();
      tx.sign(this.fee, ...extraSigners);
      return this.send(tx);
    });
    return this.poll(hash);
  }

  /** Wrap a driver-signed transaction in a fee-bump paid by F (§4.5). */
  async feeBump(inner: Transaction): Promise<TxResult> {
    const fee = (BigInt(BASE_FEE) * BigInt(inner.operations.length + 1) * 2n).toString();
    const bump = TransactionBuilder.buildFeeBumpTransaction(this.fee, fee, inner, this.passphrase);
    bump.sign(this.fee);
    return this.poll(await this.send(bump));
  }

  /** Send a fully-signed transaction (used for reserved-sequence onboarding txs). */
  async sendSigned(tx: Transaction | FeeBumpTransaction): Promise<TxResult> {
    return this.poll(await this.send(tx));
  }

  private async send(tx: Transaction | FeeBumpTransaction): Promise<string> {
    const res = await this.server.sendTransaction(tx);
    if (res.status === 'ERROR' || res.status === 'TRY_AGAIN_LATER') {
      const code = res.errorResult?.result.type ?? res.status;
      throw new ChainError(`Transaction rejected: ${code}`, undefined, code);
    }
    return res.hash;
  }

  async poll(hash: string, timeoutMs = 60_000): Promise<TxResult> {
    const start = Date.now();
    for (;;) {
      let r: rpc.Api.GetTransactionResponse;
      try {
        r = await this.server.getTransaction(hash);
      } catch (e) {
        // Transient RPC/network failure: the tx may still land, so keep polling.
        if (Date.now() - start > timeoutMs) throw new ChainError(`RPC unavailable while waiting for ${hash}: ${(e as Error).message}`);
        await new Promise((ok) => setTimeout(ok, 1000));
        continue;
      }
      if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash: hash, ledger: r.ledger, ledgerTime: new Date(r.createdAt * 1000), returnValue: r.returnValue };
      }
      if (r.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = r.resultXdr.result.type;
        throw new ChainError(`Transaction failed: ${code}`, undefined, { hash, code });
      }
      if (Date.now() - start > timeoutMs) throw new ChainError(`Timed out waiting for ${hash}`);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
}

/** The G/C address an auth entry authorizes for. */
export function authAddress(entry: xdr.SorobanAuthorizationEntry): string {
  const who = inspectAuthEntry(entry).address;
  if (who === null) throw new Error('auth entry has no address credentials');
  return who;
}

export const isAccount = (a: string) => StrKey.isValidEd25519PublicKey(a);
export { Address };
