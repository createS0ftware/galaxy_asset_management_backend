#!/usr/bin/env node
/**
 * Asset Trail open-source verifier.
 *
 *   node verify.mjs proof-pack.json [--rpc https://your-own-node]
 *
 * For every event in the pack it:
 *   1. re-canonicalises the payload (RFC 8785) and recomputes SHA-256,
 *   2. reads the asset and its trips straight from the contract's ledger entries,
 *   3. compares each payload hash with the on-chain record of the same chain sequence,
 *   4. recomputes the custody hash chain and compares it with the on-chain head.
 * Exit code 0 only if every record matches and the chain is intact.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import canonicalize from 'canonicalize';
import { nativeToScVal, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: verify.mjs proof-pack.json [--rpc <url>]');
  process.exit(2);
}
const pack = JSON.parse(readFileSync(file, 'utf8'));
const rpcUrl = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : pack.rpcUrl;
const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

const KIND = { 1: 'REGISTER', 2: 'ACTIVATE', 3: 'DISPATCH', 4: 'PICKUP', 5: 'CHECKIN', 6: 'ARRIVAL', 7: 'DELIVERY', 8: 'DISPUTE', 9: 'RESOLVE', 10: 'OVERRIDE', 11: 'FORCED_CHECKIN', 12: 'CANCEL', 15: 'RELEASE' };
const sha256 = (b) => createHash('sha256').update(b).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const str = (s) => nativeToScVal(s, { type: 'string' });
const key = (...parts) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(parts[0]), ...parts.slice(1)]);

async function read(k) {
  try {
    const e = await server.getContractData(pack.contractId, k, rpc.Durability.Persistent);
    return scValToNative(e.val.contractData.val);
  } catch (e) {
    if (/not found/i.test(String(e.message))) return null;
    throw e;
  }
}

function step(head, kind, hash, aux) {
  const k = Buffer.alloc(4);
  k.writeUInt32BE(kind);
  return sha256(Buffer.concat([head, k, hash, aux ?? Buffer.alloc(32)]));
}

// --- on-chain state -------------------------------------------------------
const network = await server.getNetwork();
if (network.passphrase !== pack.network) {
  console.error(`network mismatch: node is "${network.passphrase}", pack is "${pack.network}"`);
  process.exit(2);
}
const asset = await read(key('Asset', str(pack.asset)));
if (!asset) {
  console.error(`asset ${pack.asset} not found in contract ${pack.contractId}`);
  process.exit(1);
}
const chain = [{ seq: 1, kind: 1, hash: hex(asset.reg_hash), aux: null }];
if (asset.tag_hash) chain.push({ seq: 2, kind: 2, hash: hex(asset.tag_hash), aux: null });
for (let i = 0; i < Number(asset.trip_count); i++) {
  const tripId = await read(key('AssetTrip', str(pack.asset), xdr.ScVal.scvU32(i)));
  const trip = await read(key('Trip', str(tripId)));
  for (const r of trip.records) {
    chain.push({ seq: Number(r.seq), kind: Number(r.kind), hash: hex(r.hash), aux: r.aux ? hex(r.aux) : null, trip: tripId, ledgerTime: new Date(Number(r.timestamp) * 1000) });
  }
}
chain.sort((a, b) => a.seq - b.seq);

// --- compare --------------------------------------------------------------
let ok = true;
const rows = [];
for (const rec of chain) {
  const ev = pack.events.find((e) => e.seq === rec.seq);
  let result = 'Missing';
  if (ev) {
    const h = hex(sha256(canonicalize(JSON.parse(ev.payload))));
    const a = ev.auxPayload ? hex(sha256(canonicalize(JSON.parse(ev.auxPayload)))) : null;
    result = h === rec.hash && a === rec.aux ? 'Match' : 'Mismatch';
  }
  if (result !== 'Match') ok = false;
  rows.push({ seq: rec.seq, event: KIND[rec.kind] ?? rec.kind, trip: rec.trip ?? '', ledgerTime: rec.ledgerTime?.toISOString() ?? '', hash: rec.hash.slice(0, 12) + '…', result });
}
for (const ev of pack.events) {
  if (!chain.some((r) => r.seq === ev.seq)) {
    ok = false;
    rows.push({ seq: ev.seq, event: ev.event, trip: ev.trip ?? '', ledgerTime: '', hash: ev.hash.slice(0, 12) + '…', result: 'Not on ledger' });
  }
}
let head = Buffer.alloc(32);
for (const r of chain) head = step(head, r.kind, Buffer.from(r.hash, 'hex'), r.aux ? Buffer.from(r.aux, 'hex') : null);
const intact = hex(head) === hex(asset.head) && chain.length === Number(asset.seq);
if (!intact) ok = false;

console.table(rows);
console.log(`data source : ${rpcUrl} (${network.passphrase})`);
console.log(`contract    : ${pack.contractId}`);
console.log(`asset       : ${pack.asset}`);
console.log(`hashes      : ${rows.filter((r) => r.result === 'Match').length} of ${rows.length} match`);
console.log(`chain head  : ${hex(asset.head)} (${intact ? 'intact' : 'BROKEN'})`);
console.log(ok ? 'VERIFIED' : 'NOT VERIFIED');
process.exit(ok ? 0 : 1);
