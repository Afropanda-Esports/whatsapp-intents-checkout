//! View methods.

use near_sdk::env;
use near_sdk::json_types::{U128, U64};
use near_sdk::near;

use crate::policy::{spent_on, utc_day};
// The second `#[near]` impl emits `impl ContractExt`, generated beside `Contract`.
use crate::ContractExt;
use crate::{Contract, Limits, Order, RequestKind, RequestView};

#[near]
impl Contract {
    pub fn get_order(&self, order_ref: String) -> Option<Order> {
        self.orders.get(&order_ref).map(Order::from_stored)
    }

    pub fn get_request(&self, request_id: U64) -> Option<RequestView> {
        self.requests.get(&request_id.0).map(|request| RequestView {
            request_id,
            status: request.status.as_str().to_string(),
            amount: U128(request.amount),
            order_ref: match &request.kind {
                RequestKind::Refund { order_ref } => Some(order_ref.clone()),
                RequestKind::Payout { .. } => None,
            },
            payee: match &request.kind {
                RequestKind::Payout { payee, .. } => Some(payee.to_string()),
                RequestKind::Refund { .. } => None,
            },
            reference: match &request.kind {
                RequestKind::Payout { reference, .. } => Some(reference.clone()),
                RequestKind::Refund { .. } => None,
            },
        })
    }

    pub fn get_limits(&self) -> Limits {
        Limits {
            per_tx: U128(self.caps.per_tx),
            daily: U128(self.caps.daily),
        }
    }

    pub fn get_day_spend(&self) -> U128 {
        U128(spent_on(self.window, utc_day(env::block_timestamp())))
    }
}
