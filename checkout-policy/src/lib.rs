//! checkout-policy: treasury and spending guard for Intents Checkout.
//! `policy.rs` holds pure rules (no near-sdk); this file holds the #[near] bindings.

pub mod errors;
pub mod events;
pub mod policy;
pub mod views;
