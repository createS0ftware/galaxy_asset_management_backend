#![no_std]
//! Asset Trail: escrow + custody trail for physical assets on Stellar.
//!
//! Every check-in is one contract call that records the salted hash of the waypoint
//! payload and releases that leg's pay in the same transaction (BR-04). Each custody
//! event extends a per-asset hash chain:
//!
//! `head' = sha256(head ‖ kind_be32 ‖ hash ‖ (aux or 32 zero bytes))`, genesis head = 32 zero bytes.

mod events;
mod types;

#[cfg(test)]
mod test;

use events::{AdvanceGranted, Custody, Payout};
use soroban_sdk::{
    contract, contractimpl, panic_with_error, token, Address, Bytes, BytesN, ContractExecutable, Env, String, Vec,
};
pub use types::*;

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;

#[contract]
pub struct AssetTrail;

#[contractimpl]
impl AssetTrail {
    pub fn __constructor(env: Env, admin: Address, platform: Address, token: Address) {
        env.storage().instance().set(&DataKey::Config, &Config { admin, platform, token });
    }

    // ---------------------------------------------------------------- assets

    /// T1. Register an asset and anchor the hash of its registration payload.
    pub fn register_asset(env: Env, id: String, reg_hash: BytesN<32>) -> Asset {
        let cfg = config(&env);
        cfg.admin.require_auth();
        check_id(&env, &id);
        if env.storage().persistent().has(&DataKey::Asset(id.clone())) {
            panic_with_error!(&env, Error::AssetExists);
        }
        let mut asset = Asset {
            id: id.clone(),
            reg_hash: reg_hash.clone(),
            tag_hash: None,
            active: false,
            head: BytesN::from_array(&env, &[0u8; 32]),
            seq: 0,
            current_trip: None,
            trip_count: 0,
        };
        link(&env, &mut asset, &String::from_str(&env, ""), kind::REGISTER, 0, &reg_hash, &None, 0);
        save_asset(&env, &asset);
        asset
    }

    /// BR-01. Activate the asset once its tag has been scanned. The platform co-signs
    /// after checking the scan.
    pub fn activate_asset(env: Env, id: String, tag_hash: BytesN<32>) -> Asset {
        let cfg = config(&env);
        cfg.admin.require_auth();
        cfg.platform.require_auth();
        let mut asset = load_asset(&env, &id);
        if asset.active {
            panic_with_error!(&env, Error::AssetAlreadyActive);
        }
        asset.active = true;
        asset.tag_hash = Some(tag_hash.clone());
        link(&env, &mut asset, &String::from_str(&env, ""), kind::ACTIVATE, 0, &tag_hash, &None, 0);
        save_asset(&env, &asset);
        asset
    }

    // ----------------------------------------------------------------- trips

    /// T3. Create a trip and pull `sum(legs) + advance_limit` from the funder into
    /// escrow (BR-02 holds by construction).
    #[allow(clippy::too_many_arguments)]
    pub fn create_trip(
        env: Env,
        id: String,
        asset_id: String,
        driver: Address,
        receiver: Address,
        funder: Address,
        legs: Vec<i128>,
        advance_limit: i128,
        plan_hash: BytesN<32>,
    ) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        funder.require_auth();
        check_id(&env, &id);
        if env.storage().persistent().has(&DataKey::Trip(id.clone())) {
            panic_with_error!(&env, Error::TripExists);
        }
        if legs.len() < 2 || legs.len() > MAX_LEGS {
            panic_with_error!(&env, Error::InvalidLegs);
        }
        let mut total: i128 = 0;
        for pay in legs.iter() {
            if pay < 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
            total += pay;
        }
        if advance_limit < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut asset = load_asset(&env, &asset_id);
        if !asset.active {
            panic_with_error!(&env, Error::AssetInactive);
        }
        if asset.current_trip.is_some() {
            panic_with_error!(&env, Error::AssetBusy);
        }

        let funded = total + advance_limit;
        if funded > 0 {
            token::TokenClient::new(&env, &cfg.token).transfer(&funder, env.current_contract_address(), &funded);
        }

        let mut trip = Trip {
            id: id.clone(),
            asset: asset_id.clone(),
            driver,
            receiver,
            funder,
            legs,
            advance_limit,
            plan_hash: plan_hash.clone(),
            funded,
            released: 0,
            advanced: 0,
            pending_advance: 0,
            advance_expires_at: 0,
            next_wp: 0,
            status: TripStatus::Funded,
            records: Vec::new(&env),
        };
        let rec = link(&env, &mut asset, &id, kind::DISPATCH, 0, &plan_hash, &None, funded);
        trip.records.push_back(rec);

        let key = DataKey::AssetTrip(asset_id, asset.trip_count);
        env.storage().persistent().set(&key, &id);
        bump(&env, &key);
        asset.trip_count += 1;
        asset.current_trip = Some(id);

        save_asset(&env, &asset);
        save_trip(&env, &trip);
        trip
    }

    /// T4 / T5. Record the waypoint hash and pay the leg in one call. Waypoint 0 is the
    /// pickup. At the delivery waypoint this records arrival only; the final leg is paid
    /// by `confirm_delivery`.
    pub fn check_in(env: Env, trip_id: String, wp: u32, payload_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        let mut trip = load_trip(&env, &trip_id);
        trip.driver.require_auth();
        cfg.platform.require_auth();
        advance_waypoint(&env, &cfg, &mut trip, wp, &payload_hash, &None, false);
        save_trip(&env, &trip);
        trip
    }

    /// T8 / D1 / BR-05. Receiver signs for delivery (platform co-signs after the tag scan
    /// and inspection checklist); final leg pay minus advances goes to the driver.
    pub fn confirm_delivery(env: Env, trip_id: String, receipt_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        let mut trip = load_trip(&env, &trip_id);
        trip.receiver.require_auth();
        cfg.platform.require_auth();
        if trip.status != TripStatus::AwaitingSignature {
            panic_with_error!(&env, Error::WrongStatus);
        }
        let last = trip.legs.len() - 1;
        let pay = trip.legs.get_unchecked(last) - trip.advanced;
        pay_driver(&env, &cfg, &mut trip, pay, kind::DELIVERY);
        finish(&env, &mut trip, TripStatus::Delivered, kind::DELIVERY, last, &receipt_hash, &None, pay);
        save_trip(&env, &trip);
        trip
    }

    // -------------------------------------------------------------- advances

    /// T6. Offer the driver a fuel advance, claimable until `expires_at` (unix seconds).
    /// Capped so it can always be deducted from the final leg (BR-06).
    pub fn grant_advance(env: Env, trip_id: String, amount: i128, expires_at: u64) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        require_moving(&env, &trip);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            panic_with_error!(&env, Error::InvalidDeadline);
        }
        if trip.pending_advance > 0 && trip.advance_expires_at > now {
            panic_with_error!(&env, Error::AdvancePending);
        }
        if trip.advanced + amount > advance_cap(&trip) {
            panic_with_error!(&env, Error::AdvanceOverCap);
        }
        trip.pending_advance = amount;
        trip.advance_expires_at = expires_at;
        AdvanceGranted { trip: trip_id, amount, expires_at }.publish(&env);
        save_trip(&env, &trip);
        trip
    }

    /// T7. Driver claims the pending advance before its deadline.
    pub fn claim_advance(env: Env, trip_id: String) -> Trip {
        let cfg = config(&env);
        let mut trip = load_trip(&env, &trip_id);
        trip.driver.require_auth();
        require_moving(&env, &trip);
        let amount = trip.pending_advance;
        if amount == 0 {
            panic_with_error!(&env, Error::NoAdvance);
        }
        if env.ledger().timestamp() >= trip.advance_expires_at {
            panic_with_error!(&env, Error::AdvanceExpired);
        }
        trip.pending_advance = 0;
        trip.advanced += amount;
        pay_driver(&env, &cfg, &mut trip, amount, kind::ADVANCE);
        save_trip(&env, &trip);
        trip
    }

    // ------------------------------------------------- disputes and overrides

    /// Receiver (or the platform on their behalf) reports damage or shortage.
    /// Holds check-ins and final pay until ops resolves it.
    pub fn report_problem(env: Env, trip_id: String, by: Address, evidence_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        let mut trip = load_trip(&env, &trip_id);
        if by != trip.receiver && by != cfg.platform {
            panic_with_error!(&env, Error::NotReceiverOrPlatform);
        }
        by.require_auth();
        match trip.status {
            TripStatus::Funded | TripStatus::InTransit | TripStatus::AwaitingSignature => {}
            _ => panic_with_error!(&env, Error::WrongStatus),
        }
        trip.status = TripStatus::Disputed;
        let wp = trip.next_wp;
        record(&env, &mut trip, kind::DISPUTE, wp, &evidence_hash, &None, 0);
        save_trip(&env, &trip);
        trip
    }

    /// BR-05 / BR-07. Ops resolves a dispute: resume the trip, or release (part of)
    /// the final pay without the receiver's signature.
    pub fn resolve_dispute(env: Env, trip_id: String, resolution: Resolution, reason_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        if trip.status != TripStatus::Disputed {
            panic_with_error!(&env, Error::WrongStatus);
        }
        let wp = trip.next_wp.min(trip.legs.len() - 1);
        match resolution {
            Resolution::Resume => {
                trip.status = if trip.next_wp == 0 {
                    TripStatus::Funded
                } else if trip.next_wp == trip.legs.len() {
                    TripStatus::AwaitingSignature
                } else {
                    TripStatus::InTransit
                };
                record(&env, &mut trip, kind::RESOLVE, wp, &reason_hash, &None, 0);
            }
            Resolution::Release(pay) => {
                let max = trip.legs.get_unchecked(trip.legs.len() - 1) - trip.advanced;
                if pay < 0 || pay > max {
                    panic_with_error!(&env, Error::PayOverRemaining);
                }
                pay_driver(&env, &cfg, &mut trip, pay, kind::RESOLVE);
                finish(&env, &mut trip, TripStatus::Delivered, kind::RESOLVE, wp, &reason_hash, &None, pay);
            }
        }
        save_trip(&env, &trip);
        trip
    }

    /// BR-07. Ops records a check-in the driver could not make (e.g. phone failure),
    /// with the hash of the signed override reason. Leg pay is released as normal.
    pub fn force_check_in(env: Env, trip_id: String, wp: u32, payload_hash: BytesN<32>, reason_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        cfg.platform.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        advance_waypoint(&env, &cfg, &mut trip, wp, &payload_hash, &Some(reason_hash), true);
        save_trip(&env, &trip);
        trip
    }

    /// BR-07. Anchor any other manual override (window extension, reroute, pay hold).
    pub fn log_override(env: Env, trip_id: String, reason_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        if trip.status == TripStatus::Closed {
            panic_with_error!(&env, Error::WrongStatus);
        }
        let wp = trip.next_wp;
        record(&env, &mut trip, kind::OVERRIDE, wp, &reason_hash, &None, 0);
        save_trip(&env, &trip);
        trip
    }

    pub fn cancel_trip(env: Env, trip_id: String, reason_hash: BytesN<32>) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        match trip.status {
            TripStatus::Funded | TripStatus::InTransit | TripStatus::AwaitingSignature | TripStatus::Disputed => {}
            _ => panic_with_error!(&env, Error::WrongStatus),
        }
        let wp = trip.next_wp.min(trip.legs.len() - 1);
        finish(&env, &mut trip, TripStatus::Cancelled, kind::CANCEL, wp, &reason_hash, &None, 0);
        save_trip(&env, &trip);
        trip
    }

    /// T10 / BR-10. Return unused escrow to the funder.
    pub fn close_trip(env: Env, trip_id: String) -> Trip {
        let cfg = config(&env);
        cfg.admin.require_auth();
        let mut trip = load_trip(&env, &trip_id);
        match trip.status {
            TripStatus::Delivered | TripStatus::Cancelled => {}
            _ => panic_with_error!(&env, Error::WrongStatus),
        }
        let refund = trip.funded - trip.released;
        if refund > 0 {
            token::TokenClient::new(&env, &cfg.token).transfer(&env.current_contract_address(), &trip.funder, &refund);
            Payout { trip: trip.id.clone(), to: trip.funder.clone(), kind: kind::REFUND, amount: refund }.publish(&env);
        }
        trip.released = trip.funded;
        trip.status = TripStatus::Closed;
        save_trip(&env, &trip);
        trip
    }

    // --------------------------------------------------------------- getters

    pub fn config(env: Env) -> Config {
        config(&env)
    }

    pub fn asset(env: Env, id: String) -> Asset {
        load_asset(&env, &id)
    }

    pub fn trip(env: Env, id: String) -> Trip {
        load_trip(&env, &id)
    }

    /// The `index`-th trip ever created for an asset, so the full history can be
    /// enumerated from the ledger alone.
    pub fn asset_trip(env: Env, asset_id: String, index: u32) -> String {
        env.storage()
            .persistent()
            .get(&DataKey::AssetTrip(asset_id, index))
            .unwrap_or_else(|| panic_with_error!(&env, Error::TripNotFound))
    }

    /// Permissionless TTL bump for an asset, its trips and the contract instance.
    pub fn extend_ttl(env: Env, asset_id: String) {
        let asset = load_asset(&env, &asset_id);
        bump(&env, &DataKey::Asset(asset_id.clone()));
        for i in 0..asset.trip_count {
            let key = DataKey::AssetTrip(asset_id.clone(), i);
            bump(&env, &key);
            let trip_id: String = env.storage().persistent().get(&key).unwrap();
            bump(&env, &DataKey::Trip(trip_id));
        }
        bump_instance(&env);
    }

    // ----------------------------------------------------------------- admin

    pub fn set_platform(env: Env, platform: Address) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        cfg.platform = platform;
        env.storage().instance().set(&DataKey::Config, &cfg);
    }

    pub fn set_admin(env: Env, admin: Address) {
        let mut cfg = config(&env);
        cfg.admin.require_auth();
        admin.require_auth();
        cfg.admin = admin;
        env.storage().instance().set(&DataKey::Config, &cfg);
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        config(&env).admin.require_auth();
        env.deployer().update_current_contract(ContractExecutable::Wasm(wasm_hash));
    }
}

// ------------------------------------------------------------------- helpers

fn config(env: &Env) -> Config {
    bump_instance(env);
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn check_id(env: &Env, id: &String) {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        panic_with_error!(env, Error::InvalidId);
    }
}

fn load_asset(env: &Env, id: &String) -> Asset {
    env.storage()
        .persistent()
        .get(&DataKey::Asset(id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::AssetNotFound))
}

fn save_asset(env: &Env, asset: &Asset) {
    let key = DataKey::Asset(asset.id.clone());
    env.storage().persistent().set(&key, asset);
    bump(env, &key);
}

fn load_trip(env: &Env, id: &String) -> Trip {
    env.storage()
        .persistent()
        .get(&DataKey::Trip(id.clone()))
        .unwrap_or_else(|| panic_with_error!(env, Error::TripNotFound))
}

fn save_trip(env: &Env, trip: &Trip) {
    let key = DataKey::Trip(trip.id.clone());
    env.storage().persistent().set(&key, trip);
    bump(env, &key);
}

fn bump(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, TTL_THRESHOLD, max);
}

fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(TTL_THRESHOLD, max);
}

fn require_moving(env: &Env, trip: &Trip) {
    match trip.status {
        TripStatus::Funded | TripStatus::InTransit => {}
        _ => panic_with_error!(env, Error::WrongStatus),
    }
}

fn advance_cap(trip: &Trip) -> i128 {
    let final_leg = trip.legs.get_unchecked(trip.legs.len() - 1);
    if trip.advance_limit < final_leg {
        trip.advance_limit
    } else {
        final_leg
    }
}

/// `sha256(head ‖ kind_be32 ‖ hash ‖ (aux or 32 zero bytes))`
pub fn chain_step(env: &Env, head: &BytesN<32>, kind: u32, hash: &BytesN<32>, aux: &Option<BytesN<32>>) -> BytesN<32> {
    let mut b = Bytes::from_array(env, &head.to_array());
    b.extend_from_array(&kind.to_be_bytes());
    b.extend_from_array(&hash.to_array());
    match aux {
        Some(a) => b.extend_from_array(&a.to_array()),
        None => b.extend_from_array(&[0u8; 32]),
    }
    env.crypto().sha256(&b).to_bytes()
}

/// Extend the asset's chain, emit the custody event and return the record.
#[allow(clippy::too_many_arguments)]
fn link(
    env: &Env,
    asset: &mut Asset,
    trip_id: &String,
    kind: u32,
    wp: u32,
    hash: &BytesN<32>,
    aux: &Option<BytesN<32>>,
    amount: i128,
) -> Record {
    asset.head = chain_step(env, &asset.head, kind, hash, aux);
    asset.seq += 1;
    Custody {
        asset: asset.id.clone(),
        trip: trip_id.clone(),
        kind,
        wp,
        hash: hash.clone(),
        aux: aux.clone(),
        head: asset.head.clone(),
        seq: asset.seq,
        amount,
    }
    .publish(env);
    Record {
        kind,
        wp,
        hash: hash.clone(),
        aux: aux.clone(),
        amount,
        ledger: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
        seq: asset.seq,
    }
}

/// Link a custody record for a trip (loads and saves the asset).
fn record(env: &Env, trip: &mut Trip, kind: u32, wp: u32, hash: &BytesN<32>, aux: &Option<BytesN<32>>, amount: i128) {
    let mut asset = load_asset(env, &trip.asset);
    let rec = link(env, &mut asset, &trip.id, kind, wp, hash, aux, amount);
    trip.records.push_back(rec);
    save_asset(env, &asset);
}

/// Record the closing custody event and release the asset for its next trip.
#[allow(clippy::too_many_arguments)]
fn finish(
    env: &Env,
    trip: &mut Trip,
    status: TripStatus,
    kind: u32,
    wp: u32,
    hash: &BytesN<32>,
    aux: &Option<BytesN<32>>,
    amount: i128,
) {
    let mut asset = load_asset(env, &trip.asset);
    let rec = link(env, &mut asset, &trip.id, kind, wp, hash, aux, amount);
    trip.records.push_back(rec);
    asset.current_trip = None;
    save_asset(env, &asset);
    trip.status = status;
    trip.pending_advance = 0;
}

/// Shared by `check_in` and `force_check_in`. Pays the leg except at the delivery
/// waypoint, where it records arrival and waits for the receiver.
fn advance_waypoint(
    env: &Env,
    cfg: &Config,
    trip: &mut Trip,
    wp: u32,
    hash: &BytesN<32>,
    aux: &Option<BytesN<32>>,
    forced: bool,
) {
    require_moving(env, trip);
    if wp != trip.next_wp {
        panic_with_error!(env, Error::WrongWaypoint);
    }
    let last = trip.legs.len() - 1;
    let kind = if forced {
        kind::FORCED_CHECKIN
    } else if wp == 0 {
        kind::PICKUP
    } else if wp == last {
        kind::ARRIVAL
    } else {
        kind::CHECKIN
    };
    let pay = if wp == last { 0 } else { trip.legs.get_unchecked(wp) };
    pay_driver(env, cfg, trip, pay, kind);
    record(env, trip, kind, wp, hash, aux, pay);
    trip.next_wp += 1;
    trip.status = if wp == last { TripStatus::AwaitingSignature } else { TripStatus::InTransit };
}

fn pay_driver(env: &Env, cfg: &Config, trip: &mut Trip, amount: i128, kind: u32) {
    if amount <= 0 {
        return;
    }
    token::TokenClient::new(env, &cfg.token).transfer(&env.current_contract_address(), &trip.driver, &amount);
    trip.released += amount;
    Payout { trip: trip.id.clone(), to: trip.driver.clone(), kind, amount }.publish(env);
}
