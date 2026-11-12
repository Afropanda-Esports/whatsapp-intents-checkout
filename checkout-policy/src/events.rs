//! NEP-297 events. Logged only from the transfer callbacks.

use near_sdk::env;

pub(crate) fn refund_executed(request_id: u64, amount: u128, order_ref: &str) {
    log_event(
        "refund_executed",
        request_id,
        amount,
        "order_ref",
        order_ref,
    );
}

pub(crate) fn refund_failed(request_id: u64, amount: u128, order_ref: &str) {
    log_event("refund_failed", request_id, amount, "order_ref", order_ref);
}

pub(crate) fn payout_executed(request_id: u64, amount: u128, payee: &str) {
    log_event("payout_executed", request_id, amount, "payee", payee);
}

pub(crate) fn payout_failed(request_id: u64, amount: u128, payee: &str) {
    log_event("payout_failed", request_id, amount, "payee", payee);
}

fn log_event(event: &str, request_id: u64, amount: u128, extra_key: &str, extra_value: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"checkout_policy\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{{\"request_id\":\"{request_id}\",\"amount\":\"{amount}\",\"{extra_key}\":{}}}]}}",
        quote(extra_value),
    ));
}

fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            control if control.is_control() => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}
