# Stellar Asset Trail — contract + backend

Custody trail and per-leg driver pay for physical assets on Stellar. Every waypoint check-in
is one Soroban call that anchors the salted hash of the waypoint payload **and** pays that leg
from escrow, in the same transaction. Design decisions are in [PLAN.md](PLAN.md).

```
contracts/asset-trail/   Soroban contract (Rust): escrow, custody records, per-asset hash chain
backend/                 TypeScript API (Fastify, Drizzle/Postgres, @stellar/stellar-sdk 17)
verifier/                Standalone open-source verifier for proof packs
artifacts/               Built contract Wasm
```

## Contract

```bash
cargo test                 # 14 tests: every business rule, auth, failure paths, hash-chain vectors
stellar contract build     # → target/wasm32v1-none/release/asset_trail.wasm
```

## Backend

```bash
cd backend
npm install
npm run bootstrap:testnet  # fee/admin/platform/treasury accounts, test USDC, deploys the contract → .env.testnet
cp .env.testnet .env       # then add SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
npm run dev                # DATABASE_URL defaults to an embedded Postgres (pglite://memory)
```

For a real Postgres: `docker compose up -d` and set
`DATABASE_URL=postgres://trail:trail@localhost:5432/trail`. Migrations run on start.

Tests:

```bash
npm test                   # unit tests (no network)
npm run test:e2e           # full TR-2041 journey on testnet through the HTTP API (~2.5 min)
```

### API (prefix `/v1`)

| Surface | Routes |
|---|---|
| Public | `GET /network` · `POST /auth/staff/login` · `POST /auth/driver/otp` · `POST /auth/driver/verify` |
| Portal (staff JWT) | `POST/GET /assets` · `GET /assets/:id` · `POST /assets/:id/activate` · `POST /assets/:id/proof-links` · `POST/GET /drivers` · `POST /trips` · `GET /trips` (board + needs-attention) · `GET /trips/:id` · `POST /trips/:id/{overrides,force-checkin,resolve,cancel,close}` · `POST /advances/:id/{approve,decline}` · `GET /payments/summary` · `GET /payments/reconciliation.csv` |
| Driver (driver JWT) | `GET /driver/me` · `POST /driver/wallet/{prepare,submit}` · `GET /driver/wallet` · `GET /driver/trips[/:id]` · `POST /driver/trips/:id/{accept,checkins,checkins/batch,location,advances,advances/claim}` · `POST /driver/cashouts/{quote,:id/prepare,:id/submit}` |
| Tracking (link token) | `GET /track/:token` · `POST /track/:token/{otp,sign,report}` |
| Verify (proof link) | `GET /verify/:token[?rpc=<own node>]` · `GET /verify/:token/events/:id/payload` · `GET /verify/:token/proof-pack` |

### How a check-in works

1. Phone builds the payload (§4.2, with a 32-byte salt) and signs a Soroban **auth entry** for
   `check_in(trip, wp, sha256(payload))` — fully offline (`src/client/driver.ts`).
2. Backend runs BR-03 (geofence, GPS accuracy, tag, next waypoint, time window, staleness), checks
   the entry authorizes exactly that hash, and the platform co-signs.
3. The fee account submits; driver pay and location hash land in one transaction.

Auth entries use nonces, not sequence numbers, so offline check-ins never block each other.

## Verifier

```bash
cd verifier && npm install
node verify.mjs proof-pack.json [--rpc https://your-own-node]
```

Re-hashes each payload, reads the contract's ledger entries directly, and recomputes the hash
chain. Exit code 0 only when every record matches.

## Not in v0.1

Passkey receiver wallet (contract already accepts any `Address`), a real anchor (mock SEP-6/38
shaped anchor included), SMS provider (OTPs are logged), SEP-30 recovery, device attestation,
KMS for platform keys, multi-instance submission (needs channel accounts).
