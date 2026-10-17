#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger};
use soroban_sdk::{token::StellarAssetClient, token::TokenClient, vec, IntoVal, Symbol};

struct Setup<'a> {
    env: Env,
    client: AssetTrailClient<'a>,
    token: TokenClient<'a>,
    admin: Address,
    platform: Address,
    treasury: Address,
    driver: Address,
    receiver: Address,
}

fn ce(e: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

fn s(env: &Env, v: &str) -> String {
    String::from_str(env, v)
}

fn h(env: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(env, &[n; 32])
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);
    let admin = Address::generate(&env);
    let platform = Address::generate(&env);
    let treasury = Address::generate(&env);
    let driver = Address::generate(&env);
    let receiver = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    StellarAssetClient::new(&env, &sac.address()).mint(&treasury, &1_000_0000000);
    let contract_id = env.register(AssetTrail, (admin.clone(), platform.clone(), sac.address()));
    let client = AssetTrailClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &sac.address());
    Setup { env, client, token, admin, platform, treasury, driver, receiver }
}

/// Sample trip TR-2041: pickup + 3 checkpoints + delivery, 80 legs + 40 advance limit.
fn legs(env: &Env) -> Vec<i128> {
    vec![env, 0, 18_0000000, 22_0000000, 15_0000000, 25_0000000]
}

fn active_asset(t: &Setup, id: &str) {
    t.client.register_asset(&s(&t.env, id), &h(&t.env, 1));
    t.client.activate_asset(&s(&t.env, id), &h(&t.env, 2));
}

fn funded_trip(t: &Setup, trip: &str, asset: &str) -> Trip {
    t.client.create_trip(
        &s(&t.env, trip),
        &s(&t.env, asset),
        &t.driver,
        &t.receiver,
        &t.treasury,
        &legs(&t.env),
        &40_0000000,
        &h(&t.env, 3),
    )
}

#[test]
fn full_trip_pays_legs_deducts_advance_and_refunds() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "GX400-0041");
    let trip = funded_trip(&t, "TR-2041", "GX400-0041");
    assert_eq!(trip.funded, 120_0000000);
    assert_eq!(t.token.balance(&t.client.address), 120_0000000);

    let id = s(e, "TR-2041");
    t.client.check_in(&id, &0, &h(e, 10)); // pickup, no pay
    t.client.check_in(&id, &1, &h(e, 11));
    assert_eq!(t.token.balance(&t.driver), 18_0000000);

    t.client.grant_advance(&id, &20_0000000, &2_000_000);
    t.client.claim_advance(&id);
    assert_eq!(t.token.balance(&t.driver), 38_0000000);

    t.client.check_in(&id, &2, &h(e, 12));
    t.client.check_in(&id, &3, &h(e, 13));
    let arrived = t.client.check_in(&id, &4, &h(e, 14));
    assert_eq!(arrived.status, TripStatus::AwaitingSignature);
    assert_eq!(t.token.balance(&t.driver), 75_0000000);
    let done = t.client.confirm_delivery(&id, &h(e, 15));
    assert_eq!(done.status, TripStatus::Delivered);
    // Driver gets exactly the leg total: 18 + 20 (advance) + 22 + 15 + (25 - 20).
    assert_eq!(t.token.balance(&t.driver), 80_0000000);

    let closed = t.client.close_trip(&id);
    assert_eq!(closed.status, TripStatus::Closed);
    assert_eq!(t.token.balance(&t.client.address), 0);
    assert_eq!(t.token.balance(&t.treasury), 1_000_0000000 - 80_0000000);

    // Chain: register, activate, dispatch, pickup, 3 check-ins, arrival, delivery = 9 links.
    let asset = t.client.asset(&s(e, "GX400-0041"));
    assert_eq!(asset.seq, 9);
    assert_eq!(asset.current_trip, None);
    let mut head = BytesN::from_array(e, &[0u8; 32]);
    head = chain_step(e, &head, kind::REGISTER, &h(e, 1), &None);
    head = chain_step(e, &head, kind::ACTIVATE, &h(e, 2), &None);
    for r in closed.records.iter() {
        head = chain_step(e, &head, r.kind, &r.hash, &r.aux);
    }
    assert_eq!(head, asset.head);
    assert_eq!(closed.records.len(), 7);
    let last = closed.records.get(6).unwrap();
    assert_eq!((last.kind, last.hash, last.amount), (kind::DELIVERY, h(e, 15), 5_0000000));
}

#[test]
fn check_in_requires_driver_and_platform() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    t.client.check_in(&s(e, "T1"), &0, &h(e, 9));
    let auths = e.auths();
    let signers: std::vec::Vec<Address> = auths.iter().map(|(a, _)| a.clone()).collect();
    assert!(signers.contains(&t.driver));
    assert!(signers.contains(&t.platform));
    let (_, inv) = auths.iter().find(|(a, _)| *a == t.driver).unwrap();
    assert_eq!(
        inv.function,
        AuthorizedFunction::Contract((
            t.client.address.clone(),
            Symbol::new(e, "check_in"),
            (s(e, "T1"), 0u32, h(e, 9)).into_val(e),
        ))
    );
}

#[test]
fn delivery_requires_receiver() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    for wp in 0..5 {
        t.client.check_in(&id, &wp, &h(e, 20 + wp as u8));
    }
    t.client.confirm_delivery(&id, &h(e, 31));
    let signers: std::vec::Vec<Address> = e.auths().iter().map(|(a, _)| a.clone()).collect();
    assert!(signers.contains(&t.receiver));
    assert!(signers.contains(&t.platform));
    assert!(!signers.contains(&t.driver));
}

#[test]
fn unauthorized_check_in_fails() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    e.set_auths(&[]);
    assert!(t.client.try_check_in(&s(e, "T1"), &0, &h(e, 9)).is_err());
}

#[test]
fn waypoints_must_be_in_order_and_delivery_is_separate() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    assert_eq!(t.client.try_check_in(&id, &1, &h(e, 1)), Err(Ok(ce(Error::WrongWaypoint))));
    t.client.check_in(&id, &0, &h(e, 1));
    assert_eq!(t.client.try_check_in(&id, &0, &h(e, 1)), Err(Ok(ce(Error::WrongWaypoint))));
    t.client.check_in(&id, &1, &h(e, 1));
    t.client.check_in(&id, &2, &h(e, 1));
    assert_eq!(t.client.try_confirm_delivery(&id, &h(e, 2)), Err(Ok(ce(Error::WrongStatus))));
    t.client.check_in(&id, &3, &h(e, 1));
    t.client.check_in(&id, &4, &h(e, 1));
    assert_eq!(t.client.try_check_in(&id, &5, &h(e, 1)), Err(Ok(ce(Error::WrongStatus))));
}

#[test]
fn asset_must_be_active_and_free() {
    let t = setup();
    let e = &t.env;
    t.client.register_asset(&s(e, "A1"), &h(e, 1));
    let r = t.client.try_create_trip(&s(e, "T1"), &s(e, "A1"), &t.driver, &t.receiver, &t.treasury, &legs(e), &0, &h(e, 3));
    assert_eq!(r, Err(Ok(ce(Error::AssetInactive))));
    t.client.activate_asset(&s(e, "A1"), &h(e, 2));
    assert_eq!(t.client.try_activate_asset(&s(e, "A1"), &h(e, 2)), Err(Ok(ce(Error::AssetAlreadyActive))));
    funded_trip(&t, "T1", "A1");
    let r = t.client.try_create_trip(&s(e, "T2"), &s(e, "A1"), &t.driver, &t.receiver, &t.treasury, &legs(e), &0, &h(e, 3));
    assert_eq!(r, Err(Ok(ce(Error::AssetBusy))));
    assert_eq!(t.client.try_register_asset(&s(e, "A1"), &h(e, 1)), Err(Ok(ce(Error::AssetExists))));
    assert_eq!(t.client.try_register_asset(&s(e, ""), &h(e, 1)), Err(Ok(ce(Error::InvalidId))));
}

#[test]
fn trip_validation() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    let one = vec![e, 5i128];
    let r = t.client.try_create_trip(&s(e, "T1"), &s(e, "A1"), &t.driver, &t.receiver, &t.treasury, &one, &0, &h(e, 3));
    assert_eq!(r, Err(Ok(ce(Error::InvalidLegs))));
    let neg = vec![e, 0i128, -1];
    let r = t.client.try_create_trip(&s(e, "T1"), &s(e, "A1"), &t.driver, &t.receiver, &t.treasury, &neg, &0, &h(e, 3));
    assert_eq!(r, Err(Ok(ce(Error::InvalidAmount))));
    funded_trip(&t, "T1", "A1");
    t.client.register_asset(&s(e, "A2"), &h(e, 1));
    t.client.activate_asset(&s(e, "A2"), &h(e, 2));
    let r = t.client.try_create_trip(&s(e, "T1"), &s(e, "A2"), &t.driver, &t.receiver, &t.treasury, &legs(e), &0, &h(e, 3));
    assert_eq!(r, Err(Ok(ce(Error::TripExists))));
}

#[test]
fn advance_rules() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    // Cap is min(advance_limit 40, final leg 25).
    assert_eq!(t.client.try_grant_advance(&id, &26_0000000, &2_000_000), Err(Ok(ce(Error::AdvanceOverCap))));
    assert_eq!(t.client.try_grant_advance(&id, &1, &1_000_000), Err(Ok(ce(Error::InvalidDeadline))));
    assert_eq!(t.client.try_claim_advance(&id), Err(Ok(ce(Error::NoAdvance))));
    t.client.grant_advance(&id, &10_0000000, &1_000_100);
    assert_eq!(t.client.try_grant_advance(&id, &1, &2_000_000), Err(Ok(ce(Error::AdvancePending))));
    e.ledger().with_mut(|l| l.timestamp = 1_000_100);
    assert_eq!(t.client.try_claim_advance(&id), Err(Ok(ce(Error::AdvanceExpired))));
    // Expired advance can be replaced.
    t.client.grant_advance(&id, &25_0000000, &2_000_000);
    t.client.claim_advance(&id);
    assert_eq!(t.client.try_grant_advance(&id, &1, &3_000_000), Err(Ok(ce(Error::AdvanceOverCap))));
    assert_eq!(t.token.balance(&t.driver), 25_0000000);
}

#[test]
fn dispute_holds_and_resolution_releases() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    for wp in 0..5 {
        t.client.check_in(&id, &wp, &h(e, 1));
    }
    let stranger = Address::generate(e);
    assert_eq!(t.client.try_report_problem(&id, &stranger, &h(e, 7)), Err(Ok(ce(Error::NotReceiverOrPlatform))));
    let tr = t.client.report_problem(&id, &t.receiver, &h(e, 7));
    assert_eq!(tr.status, TripStatus::Disputed);
    assert_eq!(t.client.try_confirm_delivery(&id, &h(e, 2)), Err(Ok(ce(Error::WrongStatus))));
    assert_eq!(t.client.try_grant_advance(&id, &1, &2_000_000), Err(Ok(ce(Error::WrongStatus))));
    assert_eq!(
        t.client.try_resolve_dispute(&id, &Resolution::Release(26_0000000), &h(e, 8)),
        Err(Ok(ce(Error::PayOverRemaining)))
    );
    let tr = t.client.resolve_dispute(&id, &Resolution::Release(10_0000000), &h(e, 8));
    assert_eq!(tr.status, TripStatus::Delivered);
    assert_eq!(t.token.balance(&t.driver), 65_0000000);
    t.client.close_trip(&id);
    assert_eq!(t.token.balance(&t.treasury), 1_000_0000000 - 65_0000000);
    // Asset is free for the next trip.
    funded_trip(&t, "T2", "A1");
    assert_eq!(t.client.asset_trip(&s(e, "A1"), &1), s(e, "T2"));
}

#[test]
fn dispute_resume_continues_trip() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    t.client.report_problem(&id, &t.platform, &h(e, 7));
    let tr = t.client.resolve_dispute(&id, &Resolution::Resume, &h(e, 8));
    assert_eq!(tr.status, TripStatus::Funded);
    for wp in 0..5 {
        t.client.check_in(&id, &wp, &h(e, 1));
    }
    // Receiver reports at inspection, then ops clears it: back to awaiting signature.
    t.client.report_problem(&id, &t.receiver, &h(e, 7));
    let tr = t.client.resolve_dispute(&id, &Resolution::Resume, &h(e, 8));
    assert_eq!(tr.status, TripStatus::AwaitingSignature);
    t.client.confirm_delivery(&id, &h(e, 9));
    assert_eq!(t.token.balance(&t.driver), 80_0000000);
}

#[test]
fn cancel_and_close_refund_unreleased() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    t.client.check_in(&id, &0, &h(e, 1));
    t.client.check_in(&id, &1, &h(e, 1));
    assert_eq!(t.client.try_close_trip(&id), Err(Ok(ce(Error::WrongStatus))));
    t.client.cancel_trip(&id, &h(e, 5));
    assert_eq!(t.client.try_check_in(&id, &2, &h(e, 1)), Err(Ok(ce(Error::WrongStatus))));
    t.client.close_trip(&id);
    assert_eq!(t.token.balance(&t.treasury), 1_000_0000000 - 18_0000000);
    assert_eq!(t.client.try_close_trip(&id), Err(Ok(ce(Error::WrongStatus))));
}

#[test]
fn forced_check_in_and_override_are_anchored() {
    let t = setup();
    let e = &t.env;
    active_asset(&t, "A1");
    funded_trip(&t, "T1", "A1");
    let id = s(e, "T1");
    t.client.check_in(&id, &0, &h(e, 1));
    t.client.log_override(&id, &h(e, 40));
    let tr = t.client.force_check_in(&id, &1, &h(e, 41), &h(e, 42));
    let signers: std::vec::Vec<Address> = e.auths().iter().map(|(a, _)| a.clone()).collect();
    assert_eq!(t.token.balance(&t.driver), 18_0000000);
    let last = tr.records.get(tr.records.len() - 1).unwrap();
    assert_eq!(last.kind, kind::FORCED_CHECKIN);
    assert_eq!(last.aux, Some(h(e, 42)));
    assert_eq!(tr.records.get(tr.records.len() - 2).unwrap().kind, kind::OVERRIDE);
    assert!(signers.contains(&t.admin) && signers.contains(&t.platform));
    assert!(!signers.contains(&t.driver));
}

#[test]
fn admin_rotation() {
    let t = setup();
    let e = &t.env;
    let p2 = Address::generate(e);
    t.client.set_platform(&p2);
    assert_eq!(t.client.config().platform, p2);
    let a2 = Address::generate(e);
    t.client.set_admin(&a2);
    assert_eq!(t.client.config().admin, a2);
    active_asset(&t, "A1");
    t.client.extend_ttl(&s(e, "A1"));
}

/// Same vectors are asserted in backend/test/unit.test.ts, so the off-chain verifier and the
/// contract can't drift apart.
#[test]
fn chain_step_test_vectors() {
    let e = Env::default();
    let zero = BytesN::from_array(&e, &[0u8; 32]);
    let a = chain_step(&e, &zero, kind::REGISTER, &h(&e, 1), &None);
    assert_eq!(
        a.to_array(),
        hex32("c7695f77adeead94104841d2030de0a21d9b31717b4895c2ed03f8dd78163579")
    );
    let b = chain_step(&e, &a, kind::DELIVERY, &h(&e, 5), &Some(h(&e, 9)));
    assert_eq!(
        b.to_array(),
        hex32("9ebcf3aa3252766db734ca41f4a6964c7d06e220ba4e300c8994c0112480f6d8")
    );
}

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}
