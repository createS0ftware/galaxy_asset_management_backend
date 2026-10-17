import { Asset, Keypair, rpc } from '@stellar/stellar-sdk';
import type { Config } from './config.js';
import { openDb, type Db } from './db/client.js';
import { MockAnchor, type Anchor } from './services/anchor.js';
import { PlatformSigner } from './services/signer.js';
import { DevSms, type Sms } from './services/sms.js';
import { parseAsset } from './stellar/accounts.js';
import { Submitter } from './stellar/submitter.js';
import { TrailContract } from './stellar/trail.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Ctx {
  config: Config;
  db: Db;
  log: Logger;
  server: rpc.Server;
  sub: Submitter;
  trail: TrailContract;
  usdc: Asset;
  /** Ops admin key: registers assets, creates trips, grants advances, overrides. */
  admin: Keypair;
  /** Treasury key: authorizes the escrow transfer when a trip is funded. */
  treasury: Keypair;
  /** The only holder of the platform key (BR-03). */
  signer: PlatformSigner;
  sms: Sms;
  anchor: Anchor;
  close(): Promise<void>;
}

export async function createContext(config: Config, opts: { log?: Logger; sms?: Sms; anchor?: Anchor } = {}): Promise<Ctx> {
  const log = opts.log ?? console;
  const { db, close } = await openDb(config.DATABASE_URL);
  const server = new rpc.Server(config.STELLAR_RPC_URL, { allowHttp: config.STELLAR_RPC_URL.startsWith('http://') });
  const sub = new Submitter(server, config.STELLAR_NETWORK_PASSPHRASE, Keypair.fromSecret(config.FEE_SECRET));
  const trail = new TrailContract(sub, config.CONTRACT_ID);
  return {
    config,
    db,
    log,
    server,
    sub,
    trail,
    usdc: parseAsset(config.PAY_ASSET),
    admin: Keypair.fromSecret(config.ADMIN_SECRET),
    treasury: Keypair.fromSecret(config.TREASURY_SECRET),
    signer: new PlatformSigner(Keypair.fromSecret(config.PLATFORM_SECRET), trail),
    sms: opts.sms ?? new DevSms((m) => log.info(m)),
    anchor: opts.anchor ?? new MockAnchor(config.MOCK_ANCHOR_ACCOUNT ?? Keypair.fromSecret(config.TREASURY_SECRET).publicKey()),
    close,
  };
}
