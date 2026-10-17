/**
 * Check a deployed asset-trail contract against a release build.
 *
 *   tsx --env-file=.env.testnet scripts/verify-deployment.ts <release.wasm>
 *
 * 1. Downloads the Wasm the network actually runs for CONTRACT_ID and compares its SHA-256
 *    with the release artifact.
 * 2. Reads the contract config and checks admin / platform / token match this environment.
 * Exits non-zero on any mismatch.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';
import { parseAsset } from '../src/stellar/accounts.js';
import { Submitter } from '../src/stellar/submitter.js';
import { TrailContract } from '../src/stellar/trail.js';
import { scValToNative, xdr } from '@stellar/stellar-sdk';

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error('usage: verify-deployment.ts <release.wasm>');
  process.exit(2);
}
const cfg = loadConfig();
const server = new rpc.Server(cfg.STELLAR_RPC_URL);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let ok = true;
const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) ok = false;
  console.log(`${pass ? '✔' : '✘'} ${name.padEnd(22)} ${detail}`);
};

const release = sha(readFileSync(wasmPath));
const onChain = sha(await server.getContractWasmByContractId(cfg.CONTRACT_ID));
check('wasm hash', release === onChain, `release ${release}\n${' '.repeat(25)}ledger  ${onChain}`);

const trail = new TrailContract(new Submitter(server, cfg.STELLAR_NETWORK_PASSPHRASE, Keypair.fromSecret(cfg.FEE_SECRET)), cfg.CONTRACT_ID);
const instance = await server.getContractInstance(cfg.CONTRACT_ID);
const storage = (instance as unknown as { storage: xdr.ScMapEntry[] | null }).storage ?? [];
const entry = storage.find((e) => JSON.stringify(scValToNative(e.key)) === JSON.stringify(['Config']));
const conf = entry ? (scValToNative(entry.val) as { admin: string; platform: string; token: string }) : null;
const sac = parseAsset(cfg.PAY_ASSET).contractId(cfg.STELLAR_NETWORK_PASSPHRASE);
check('config.admin', conf?.admin === Keypair.fromSecret(cfg.ADMIN_SECRET).publicKey(), conf?.admin ?? 'missing');
check('config.platform', conf?.platform === Keypair.fromSecret(cfg.PLATFORM_SECRET).publicKey(), conf?.platform ?? 'missing');
check('config.token', conf?.token === sac, `${conf?.token ?? 'missing'} (${cfg.PAY_ASSET.split(':')[0]} SAC)`);
check('contract reachable', (await trail.asset('__none__')) === null, cfg.CONTRACT_ID);

console.log(ok ? 'DEPLOYMENT VERIFIED' : 'DEPLOYMENT MISMATCH');
process.exit(ok ? 0 : 1);
