//! Stable rejection codes for `checkout-policy`.
//!
//! WORKED EXAMPLE — read this file before stage 1 of LEARNING.md. It is given,
//! not an exercise, because the tests in `policy.rs` depend on it.
//!
//! Concepts on show:
//! - A fieldless `enum` as a closed set of outcomes. Adding a variant forces every
//!   exhaustive `match` in the crate to handle it, so the compiler finds the gaps.
//! - `#[derive(...)]`: `Debug` for `{:?}` and test failure output, `Clone, Copy`
//!   because the type is a tag (no heap data) and is cheap to copy, `PartialEq, Eq`
//!   so tests can `assert_eq!` on it.
//! - `&'static str`: a string slice that lives for the whole program (it is baked
//!   into the binary), so returning it never allocates and never dangles.
//! - Implementing a standard trait (`Display`) so the type works with `format!`,
//!   `to_string()` and `panic!("{err}")`.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    NotOperator,
    NotOwner,
    Paused,
    OrderConflict,
    UnknownOrder,
    Fulfilled,
    AmountExceedsReceived,
    ZeroAmount,
    PayeeNotAllowed,
    NotApproved,
    AlreadyExecuted,
    NotEscalated,
    /// u128 arithmetic would overflow. Should never happen with USDC amounts,
    /// but money code proves it instead of assuming it.
    Overflow,
}

impl PolicyError {
    /// The stable `E_*` code. Contract callers and the service match on this
    /// string, so these values must never change once deployed.
    pub const fn code(self) -> &'static str {
        match self {
            PolicyError::NotOperator => "E_NOT_OPERATOR",
            PolicyError::NotOwner => "E_NOT_OWNER",
            PolicyError::Paused => "E_PAUSED",
            PolicyError::OrderConflict => "E_ORDER_CONFLICT",
            PolicyError::UnknownOrder => "E_UNKNOWN_ORDER",
            PolicyError::Fulfilled => "E_FULFILLED",
            PolicyError::AmountExceedsReceived => "E_AMOUNT_EXCEEDS_RECEIVED",
            PolicyError::ZeroAmount => "E_ZERO_AMOUNT",
            PolicyError::PayeeNotAllowed => "E_PAYEE_NOT_ALLOWED",
            PolicyError::NotApproved => "E_NOT_APPROVED",
            PolicyError::AlreadyExecuted => "E_ALREADY_EXECUTED",
            PolicyError::NotEscalated => "E_NOT_ESCALATED",
            PolicyError::Overflow => "E_OVERFLOW",
        }
    }
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_is_the_stable_code() {
        assert_eq!(PolicyError::Fulfilled.to_string(), "E_FULFILLED");
    }
}
