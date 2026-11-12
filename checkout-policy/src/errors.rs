//! Stable rejection codes for `checkout-policy`.

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
