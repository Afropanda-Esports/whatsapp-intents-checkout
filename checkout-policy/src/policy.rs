//! Pure spending rules for `checkout-policy`: caps, the UTC-day window and refund
//! eligibility.

use crate::errors::PolicyError;

/// USDC base units (6 decimals). `u128` matches NEP-141 `U128` balances.
pub type Amount = u128;

/// Nanoseconds in one UTC day. `env::block_timestamp()` is in nanoseconds.
pub const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub per_tx: Amount,
    pub daily: Amount,
}

/// What has been reserved against the daily cap, and for which UTC day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DayWindow {
    pub day: u64,
    pub spent: Amount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approved,
    Escalated,
}

/// The refund-relevant part of a registered order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderRefundState {
    pub received: Amount,
    /// Completed refunds.
    pub refunded: Amount,
    /// Refunds requested (approved or escalated) but not yet completed or released.
    pub reserved: Amount,
    pub fulfilled: bool,
}

/// UTC day number for a block timestamp in nanoseconds.
pub fn utc_day(block_timestamp_ns: u64) -> u64 {
    block_timestamp_ns / NANOS_PER_DAY
}

/// Amount already reserved today. A window from an earlier day counts as zero.
pub fn spent_on(window: DayWindow, today: u64) -> Amount {
    if window.day == today {
        window.spent
    } else {
        0
    }
}

/// Approve or escalate a refund/payout request.
///
/// - `amount == 0` → `Err(ZeroAmount)`
/// - `amount > caps.per_tx` → `Escalated`
/// - today's spend + `amount` > `caps.daily` → `Escalated`
/// - otherwise → `Approved`
///
/// Overflow while adding → `Err(Overflow)`.
pub fn decide(
    caps: Caps,
    window: DayWindow,
    today: u64,
    amount: Amount,
) -> Result<Decision, PolicyError> {
    if amount == 0 {
        return Err(PolicyError::ZeroAmount);
    }
    if amount > caps.per_tx {
        return Ok(Decision::Escalated);
    }
    let after = spent_on(window, today)
        .checked_add(amount)
        .ok_or(PolicyError::Overflow)?;
    if after > caps.daily {
        Ok(Decision::Escalated)
    } else {
        Ok(Decision::Approved)
    }
}

/// Reserve `amount` against today's window. Returns a new window.
pub fn reserve(window: DayWindow, today: u64, amount: Amount) -> Result<DayWindow, PolicyError> {
    let spent = spent_on(window, today)
        .checked_add(amount)
        .ok_or(PolicyError::Overflow)?;
    Ok(DayWindow { day: today, spent })
}

/// Undo a reservation made on `reserved_day` after a failed `ft_transfer`.
/// If the window has already rolled to a later day, there is nothing to undo.
pub fn release(window: DayWindow, reserved_day: u64, amount: Amount) -> DayWindow {
    if window.day == reserved_day {
        DayWindow {
            day: window.day,
            spent: window.spent.saturating_sub(amount),
        }
    } else {
        window
    }
}

/// How much of the order can still be refunded: received − refunded − reserved,
/// floored at zero so an inconsistent order rejects every refund (fails closed).
pub fn refundable(order: &OrderRefundState) -> Amount {
    order
        .received
        .saturating_sub(order.refunded)
        .saturating_sub(order.reserved)
}

/// Check a refund request against the order, in this order:
/// zero amount → `ZeroAmount`; fulfilled → `Fulfilled`;
/// `amount > refundable(order)` (which already subtracts `reserved`) → `AmountExceedsReceived`.
pub fn check_refund(order: &OrderRefundState, amount: Amount) -> Result<(), PolicyError> {
    if amount == 0 {
        return Err(PolicyError::ZeroAmount);
    }
    if order.fulfilled {
        return Err(PolicyError::Fulfilled);
    }
    if amount > refundable(order) {
        return Err(PolicyError::AmountExceedsReceived);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: Amount = 1_000_000; // 1 USDC in base units
    const CAPS: Caps = Caps {
        per_tx: 50 * USDC,
        daily: 200 * USDC,
    };
    const DAY: u64 = 20_397; // 5 Nov 2026

    fn window(day: u64, spent: Amount) -> DayWindow {
        DayWindow { day, spent }
    }

    fn order(received: Amount, refunded: Amount, fulfilled: bool) -> OrderRefundState {
        reserved_order(received, refunded, 0, fulfilled)
    }

    fn reserved_order(
        received: Amount,
        refunded: Amount,
        reserved: Amount,
        fulfilled: bool,
    ) -> OrderRefundState {
        OrderRefundState {
            received,
            refunded,
            reserved,
            fulfilled,
        }
    }

    // --- utc_day ---------------------------------------------------------

    #[test]
    fn utc_day_floors_to_the_day() {
        assert_eq!(utc_day(0), 0);
        assert_eq!(utc_day(NANOS_PER_DAY - 1), 0);
        assert_eq!(utc_day(NANOS_PER_DAY), 1);
        assert_eq!(
            utc_day(DAY * NANOS_PER_DAY + 12 * 3_600 * 1_000_000_000),
            DAY
        );
    }

    // --- spent_on --------------------------------------------------------

    #[test]
    fn spent_on_counts_only_today() {
        assert_eq!(spent_on(window(DAY, 30 * USDC), DAY), 30 * USDC);
        assert_eq!(spent_on(window(DAY - 1, 30 * USDC), DAY), 0);
        assert_eq!(spent_on(DayWindow::default(), DAY), 0);
    }

    // --- decide ----------------------------------------------------------

    #[test]
    fn zero_amount_is_rejected() {
        assert_eq!(
            decide(CAPS, window(DAY, 0), DAY, 0),
            Err(PolicyError::ZeroAmount)
        );
    }

    #[test]
    fn within_both_caps_is_approved() {
        assert_eq!(
            decide(CAPS, window(DAY, 0), DAY, 10 * USDC),
            Ok(Decision::Approved)
        );
    }

    #[test]
    fn exactly_the_per_tx_cap_is_approved() {
        assert_eq!(
            decide(CAPS, window(DAY, 0), DAY, 50 * USDC),
            Ok(Decision::Approved)
        );
    }

    #[test]
    fn above_the_per_tx_cap_escalates() {
        assert_eq!(
            decide(CAPS, window(DAY, 0), DAY, 50 * USDC + 1),
            Ok(Decision::Escalated)
        );
    }

    #[test]
    fn filling_the_daily_cap_exactly_is_approved() {
        assert_eq!(
            decide(CAPS, window(DAY, 150 * USDC), DAY, 50 * USDC),
            Ok(Decision::Approved)
        );
    }

    #[test]
    fn going_past_the_daily_cap_escalates() {
        assert_eq!(
            decide(CAPS, window(DAY, 190 * USDC), DAY, 11 * USDC),
            Ok(Decision::Escalated)
        );
    }

    #[test]
    fn yesterdays_spend_does_not_count() {
        assert_eq!(
            decide(CAPS, window(DAY - 1, 200 * USDC), DAY, 50 * USDC),
            Ok(Decision::Approved)
        );
    }

    #[test]
    fn overflow_is_an_error_not_a_panic() {
        let huge = Caps {
            per_tx: Amount::MAX,
            daily: Amount::MAX,
        };
        assert_eq!(
            decide(huge, window(DAY, Amount::MAX), DAY, 1),
            Err(PolicyError::Overflow)
        );
    }

    // --- reserve / release -----------------------------------------------

    #[test]
    fn reserve_adds_to_todays_window() {
        assert_eq!(
            reserve(window(DAY, 10 * USDC), DAY, 5 * USDC),
            Ok(window(DAY, 15 * USDC))
        );
    }

    #[test]
    fn reserve_on_a_new_day_starts_a_fresh_window() {
        assert_eq!(
            reserve(window(DAY - 1, 180 * USDC), DAY, 5 * USDC),
            Ok(window(DAY, 5 * USDC))
        );
    }

    #[test]
    fn reserve_overflow_is_an_error() {
        assert_eq!(
            reserve(window(DAY, Amount::MAX), DAY, 1),
            Err(PolicyError::Overflow)
        );
    }

    #[test]
    fn release_undoes_a_same_day_reservation() {
        assert_eq!(
            release(window(DAY, 15 * USDC), DAY, 5 * USDC),
            window(DAY, 10 * USDC)
        );
    }

    #[test]
    fn release_after_the_day_rolled_changes_nothing() {
        assert_eq!(
            release(window(DAY, 7 * USDC), DAY - 1, 5 * USDC),
            window(DAY, 7 * USDC)
        );
    }

    #[test]
    fn release_never_goes_below_zero() {
        assert_eq!(
            release(window(DAY, 3 * USDC), DAY, 5 * USDC),
            window(DAY, 0)
        );
    }

    // --- refunds ---------------------------------------------------------

    #[test]
    fn refundable_is_received_minus_refunded() {
        assert_eq!(refundable(&order(10 * USDC, 4 * USDC, false)), 6 * USDC);
    }

    #[test]
    fn partial_refund_within_received_is_allowed() {
        assert_eq!(check_refund(&order(10 * USDC, 0, false), 5 * USDC), Ok(()));
    }

    #[test]
    fn refunding_the_full_remainder_is_allowed() {
        assert_eq!(
            check_refund(&order(10 * USDC, 4 * USDC, false), 6 * USDC),
            Ok(())
        );
    }

    #[test]
    fn refund_above_remainder_is_rejected() {
        assert_eq!(
            check_refund(&order(10 * USDC, 4 * USDC, false), 6 * USDC + 1),
            Err(PolicyError::AmountExceedsReceived)
        );
    }

    #[test]
    fn refund_after_fulfilment_is_rejected() {
        assert_eq!(
            check_refund(&order(10 * USDC, 0, true), USDC),
            Err(PolicyError::Fulfilled)
        );
    }

    #[test]
    fn zero_refund_is_rejected_before_anything_else() {
        assert_eq!(
            check_refund(&order(10 * USDC, 0, true), 0),
            Err(PolicyError::ZeroAmount)
        );
    }

    #[test]
    fn check_refund_only_borrows_the_order() {
        let o = order(10 * USDC, 0, false);
        let _ = check_refund(&o, USDC);
        let _ = check_refund(&o, USDC); // `o` is still usable: it was borrowed, not moved
        assert_eq!(o.received, 10 * USDC);
    }

    // --- in-flight refunds ----------------------------------------------

    #[test]
    fn refundable_subtracts_reserved() {
        assert_eq!(
            refundable(&reserved_order(10 * USDC, 2 * USDC, 3 * USDC, false)),
            5 * USDC
        );
    }

    #[test]
    fn refund_up_to_received_minus_refunded_minus_reserved_is_allowed() {
        let o = reserved_order(10 * USDC, 2 * USDC, 3 * USDC, false);
        assert_eq!(check_refund(&o, 5 * USDC), Ok(()));
        assert_eq!(
            check_refund(&o, 5 * USDC + 1),
            Err(PolicyError::AmountExceedsReceived)
        );
    }

    #[test]
    fn fully_reserved_order_rejects_any_refund() {
        let o = reserved_order(10 * USDC, 0, 10 * USDC, false);
        assert_eq!(check_refund(&o, 1), Err(PolicyError::AmountExceedsReceived));
    }

    #[test]
    fn inconsistent_order_fails_closed() {
        let o = reserved_order(10 * USDC, 6 * USDC, 6 * USDC, false);
        assert_eq!(refundable(&o), 0);
        assert_eq!(check_refund(&o, 1), Err(PolicyError::AmountExceedsReceived));
    }

    #[test]
    fn zero_amount_is_checked_before_fulfilment_and_reservation() {
        let o = reserved_order(10 * USDC, 0, 10 * USDC, true);
        assert_eq!(check_refund(&o, 0), Err(PolicyError::ZeroAmount));
    }

    #[test]
    fn reserve_then_release_on_the_same_day_round_trips() {
        let start = window(DAY, 12 * USDC);
        let reserved = reserve(start, DAY, 5 * USDC).expect("reserve");
        assert_eq!(release(reserved, DAY, 5 * USDC), start);
    }
}
