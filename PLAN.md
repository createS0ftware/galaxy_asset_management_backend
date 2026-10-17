# Stellar Asset Trail — Build Plan (v0.1)

Source spec: *Stellar Asset Trail — Product & Journey Spec v0.1*. This document records
how we turn it into a Soroban contract + backend, and which open decisions we took.

## 1. Decisions taken

| ID | Decision | Choice | Why |
|----|----------|--------|-----|
| D2 | Escrow model | **Soroban escrow contract** (`asset-trail`) instead of platform-controlled trip accounts | Removes the platform's ability to move escrow outside the rules; leg pay, advances and final pay are released only by contract logic. |
| D5 | Where location records live | **Contract storage + contract events**, plus a per-asset **hash chain** | Proof and pay must share one transaction (BR-04) and a Soroban tx holds exactly one `InvokeHostFunction`, so the classic `ManageData("wp")` bundle cannot be in the same tx. The hash-chain head is a single ledger entry an auditor can check forever, even after RPC event retention expires. |
| D1 | How the receiver signs | Contract takes any `Address` and calls `receiver.require_auth()` → works for **passkey smart wallets (option A)** unchanged. Backend v0.1 ships **option B** (platform-custodied ed25519 key per receiver, unlocked by SMS OTP). | Contract is future-proof; option B ships without a WebAuthn front end. |
| D3 | Cash-out | Anchor client behind an interface; SEP-10/SEP-6/SEP-38 shape; **mock anchor** in dev | Anchor partner (D6) not chosen yet. |
| D4 | Depot co-signer | Out of scope (driver + platform only) | As spec. |
| D7 | Pay asset | Any SEP-41 token; **USDC SAC** in production, a test "USDC" SAC on testnet | Contract is asset-agnostic. |

### Consequences vs. the spec's classic design

* **No per-trip accounts (E)** — the contract is the escrow. **No per-asset accounts (A)** — the
  asset's on-chain identity is `(contract id, asset id)`; its history is the hash chain + events.
  This saves ~2 sponsored reserves per asset/trip.
* **No fee-bumps / no driver sequence numbers.** The fee account **F is the transaction source**;
  driver, platform and receiver only sign **Soroban authorization entries**. Auth entries use random
  nonces, not sequence numbers, so offline check-ins can be signed on the phone with no network and
  submitted later, and BR-09's sequence problem disappears for check-ins. The auth entry's
  `signatureExpirationLedger` plays the role of the spec's `maxTime`.
* Driver wallets (D) stay classic `G…` accounts with a **sponsored USDC trustline** (T2), so they can
  receive USDC and cash out to an anchor.
* Advances (T6/T7) become contract state (`grant_advance` / `claim_advance` with deadline) instead of
  claimable balances. **BR-06 interpretation:** outstanding advances are deducted from the final leg,
  so an advance is capped at `min(advance_limit, final_leg_pay)` minus what is already advanced.

## 2. Smart contract — `contracts/asset-trail`

State
* `Config { admin, platform, token }` (instance)
* `Asset { id, owner_ref, reg_hash, tag_hash, active, head, events, current_trip }` (persistent)
* `Trip { id, asset, driver, receiver, funder, legs: Vec<i128>, advance_limit, plan_hash, deadline,
  next_wp, paid, advanced, pending_advance, status, records: Vec<Record> }` (persistent)

Functions (auth in brackets)
| Fn | Auth | Spec |
|----|------|------|
| `__constructor(admin, platform, token)` | — | deploy |
| `register_asset(id, reg_hash)` | admin | T1 |
| `activate_asset(id, tag_hash)` | admin + platform | BR-01 |
| `create_trip(id, asset, driver, receiver, funder, legs, advance_limit, plan_hash, deadline)` | admin + funder | T3, BR-02 (escrow pulled = Σlegs + advance_limit). `deadline` (unix s, must be in the future, else `InvalidDeadline`) is when an unsigned final leg becomes claimable |
| `check_in(trip, wp, payload_hash)` | driver + platform | T4/T5, BR-03 (next wp), BR-04. At the delivery waypoint it records **arrival** (no pay) → `AwaitingSignature` |
| `confirm_delivery(trip, receipt_hash)` | receiver + platform | T8, BR-05: final leg minus advances |
| `claim_final_pay(trip, claim_hash)` | driver only | §4.6: still `AwaitingSignature` after `deadline` (else `WrongStatus` / `DeadlineNotPassed`) → final leg minus advances, custody kind `RELEASE` (15), `Delivered` |
| `grant_advance(trip, amount, expires_at)` / `claim_advance(trip)` | admin / driver | T6/T7, BR-06 |
| `report_problem(trip, evidence_hash)` | receiver or platform | dispute hold. Refused with `DeadlinePassed` once the trip is awaiting the signature past `deadline` |
| `resolve_dispute(trip, pay, reason_hash)` | admin | BR-05 override, BR-07 |
| `force_check_in(trip, wp, payload_hash, reason_hash)` / `log_override(...)` | admin + platform | BR-07 |
| `cancel_trip(trip, reason_hash)` / `close_trip(trip)` | admin | T10, BR-10 |
| getters, `set_platform`, `set_admin`, `upgrade` | admin | ops |

Every custody event: `head' = sha256(head ‖ kind ‖ payload_hash)`, appended `Record`, event emitted
with topics `(kind, asset_id, trip_id)`.

## 3. Backend — `backend/` (TypeScript, Fastify 5, Drizzle + Postgres, @stellar/stellar-sdk)

Modules
* **payload** — RFC 8785 canonical JSON + salted SHA-256 (§4.2), salt generation.
* **stellar** — RPC client, contract client, auth-entry building/signing (phone side + platform
  side), tx assembly with F as source, account bootstrap (sponsored driver wallet T2).
* **signer** — the only holder of the platform key (KMS interface; env key in dev). Co-signs an auth
  entry only after BR-03: geofence (haversine ≤ radius + accuracy), tag match, next expected
  waypoint, time window, payload hash = auth-entry arg.
* **assets / drivers / trips / checkins / receiver / payments / overrides** — REST API for portal,
  driver app and tracking page. Offline queue: driver uploads `{payload, signedAuthEntry}` in order.
* **indexer** — polls RPC `getEvents` for the contract, stores ledger events, reconciles payouts.
* **verify** — proof links (scoped to one asset, expiring, views logged), re-hash payloads,
  compare to on-chain records & chain head, flags (offline gaps, overrides), proof-pack JSON.
* **anchor** — interface + mock (SEP-6/38 shaped quotes, cash-out tx builder).

Auth: staff JWT (portal), driver JWT via phone OTP, receiver via tracking token + OTP.

## 4. Verifier — `verifier/`
Standalone open-source script: takes a proof pack + any RPC URL, re-hashes payloads, recomputes the
hash chain, reads the contract's on-chain state, prints Match / Mismatch / Missing per event.

### Change made during build
Delivery is split into the driver's **arrival** check-in and the receiver's `confirm_delivery`.
With a single call needing driver + receiver signatures over the receipt hash, the driver could
only sign after the receiver — impossible for an offline-signed check-in. Arrival maps directly
to the spec's "Awaiting signature" trip status.

## 5. Milestones
1. Contract + unit tests (all business rules, auth, failure paths).
2. Backend core: payload hashing, Stellar client, signer, DB schema, API.
3. Tests: unit + integration with in-process Postgres (PGlite) and the contract on testnet.
4. Testnet bootstrap script: fee account, treasury, test USDC, deploy contract, run a demo trip.

## 6. Not in v0.1
Passkey receiver wallet (D1-A front end), real anchor (D6), SEP-30 recovery, device attestation,
NTAG 424 verification, map provider, SMS provider (OTP is logged in dev).
