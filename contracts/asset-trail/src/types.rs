use soroban_sdk::{contracterror, contracttype, Address, BytesN, String, Vec};

/// Custody event kinds. The numeric value is part of the hash-chain preimage, so it
/// must never change once deployed.
pub mod kind {
    pub const REGISTER: u32 = 1;
    pub const ACTIVATE: u32 = 2;
    pub const DISPATCH: u32 = 3;
    pub const PICKUP: u32 = 4;
    pub const CHECKIN: u32 = 5;
    /// Driver checked in at the delivery waypoint; final pay waits for the receiver.
    pub const ARRIVAL: u32 = 6;
    pub const DELIVERY: u32 = 7;
    pub const DISPUTE: u32 = 8;
    pub const RESOLVE: u32 = 9;
    pub const OVERRIDE: u32 = 10;
    pub const FORCED_CHECKIN: u32 = 11;
    pub const CANCEL: u32 = 12;
    // Payout-only kinds (not part of the custody chain).
    pub const ADVANCE: u32 = 13;
    pub const REFUND: u32 = 14;
    /// Custody kind (part of the hash chain): final leg released to the driver after the
    /// delivery deadline, with no receiver signature or dispute.
    pub const RELEASE: u32 = 15;
}

pub const MAX_ID_LEN: u32 = 64;
pub const MAX_LEGS: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidId = 1,
    AssetExists = 2,
    AssetNotFound = 3,
    AssetInactive = 4,
    AssetBusy = 5,
    AssetAlreadyActive = 6,
    TripExists = 7,
    TripNotFound = 8,
    InvalidLegs = 9,
    InvalidAmount = 10,
    WrongStatus = 11,
    WrongWaypoint = 12,
    AdvanceOverCap = 14,
    AdvancePending = 15,
    NoAdvance = 16,
    AdvanceExpired = 17,
    NotReceiverOrPlatform = 18,
    PayOverRemaining = 19,
    InvalidDeadline = 20,
    DeadlineNotPassed = 21,
    DeadlinePassed = 22,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// The signer-service key. Co-signs check-ins only after off-chain checks (BR-03).
    pub platform: Address,
    /// SEP-41 token used for pay (USDC SAC in production).
    pub token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Asset {
    pub id: String,
    /// Hash of the registration payload (metadata, document hashes, salt).
    pub reg_hash: BytesN<32>,
    /// Salted hash of the tag ID, set on activation (BR-01).
    pub tag_hash: Option<BytesN<32>>,
    pub active: bool,
    /// Head of the asset's custody hash chain.
    pub head: BytesN<32>,
    /// Number of links in the chain.
    pub seq: u32,
    pub current_trip: Option<String>,
    pub trip_count: u32,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TripStatus {
    /// Escrow funded, waiting for pickup.
    Funded,
    /// Picked up, moving between waypoints.
    InTransit,
    /// Driver checked in at the delivery waypoint; waiting for the receiver to sign.
    AwaitingSignature,
    /// Problem reported; check-ins and final pay held.
    Disputed,
    Delivered,
    Cancelled,
    /// Unused escrow returned to the funder.
    Closed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Record {
    pub kind: u32,
    pub wp: u32,
    pub hash: BytesN<32>,
    /// Secondary hash: receiver receipt (delivery) or override reason.
    pub aux: Option<BytesN<32>>,
    pub amount: i128,
    pub ledger: u32,
    pub timestamp: u64,
    /// Chain sequence number of this record within the asset's chain.
    pub seq: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Trip {
    pub id: String,
    pub asset: String,
    pub driver: Address,
    pub receiver: Address,
    pub funder: Address,
    /// Pay per waypoint. Index 0 is pickup, the last index is delivery.
    pub legs: Vec<i128>,
    pub advance_limit: i128,
    pub plan_hash: BytesN<32>,
    /// Ledger timestamp (unix seconds) set at dispatch: after it, with no receiver signature or
    /// dispute, the driver can claim the final leg (`claim_final_pay`).
    pub deadline: u64,
    pub funded: i128,
    /// Everything sent to the driver: leg pay, claimed advances, final pay.
    pub released: i128,
    /// Claimed advances, deducted from the final leg (BR-06).
    pub advanced: i128,
    /// Granted, unclaimed advance (0 = none).
    pub pending_advance: i128,
    /// Ledger timestamp (unix seconds) after which the pending advance can't be claimed.
    pub advance_expires_at: u64,
    /// Next expected waypoint index.
    pub next_wp: u32,
    pub status: TripStatus,
    pub records: Vec<Record>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Resolution {
    /// Problem cleared mid-route: trip continues.
    Resume,
    /// Close the dispute and pay the driver this much of the final leg.
    Release(i128),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Asset(String),
    Trip(String),
    AssetTrip(String, u32),
}
