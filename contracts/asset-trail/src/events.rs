use soroban_sdk::{contractevent, Address, BytesN, String};

/// One link of an asset's custody chain. `trip` is empty for asset-level events.
#[contractevent(topics = ["custody"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Custody {
    #[topic]
    pub asset: String,
    #[topic]
    pub trip: String,
    pub kind: u32,
    pub wp: u32,
    pub hash: BytesN<32>,
    pub aux: Option<BytesN<32>>,
    pub head: BytesN<32>,
    pub seq: u32,
    pub amount: i128,
}

/// Any token movement out of escrow.
#[contractevent(topics = ["payout"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    #[topic]
    pub trip: String,
    #[topic]
    pub to: Address,
    pub kind: u32,
    pub amount: i128,
}

#[contractevent(topics = ["advance"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvanceGranted {
    #[topic]
    pub trip: String,
    pub amount: i128,
    pub expires_at: u64,
}
