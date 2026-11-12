//! checkout-policy: treasury and spending guard for Intents Checkout.

pub mod errors;
pub mod events;
pub mod policy;
pub mod views;

use near_sdk::borsh::io::{Read, Result as BorshResult, Write};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

use crate::errors::PolicyError;
use crate::policy::{
    check_refund, decide, release, reserve, utc_day, Caps, DayWindow, Decision, OrderRefundState,
};

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Orders,
    Requests,
    Payees,
}

/// One registered payment. Amounts are base units. Borsh stores the `u128` values.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct StoredOrder {
    amount_received: u128,
    refunded: u128,
    reserved: u128,
    refund_destination: String,
    origin_asset: String,
    fulfilled: bool,
}

/// JSON view of an order. Amounts are strings because a JSON number cannot hold a `u128`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub amount_received: U128,
    pub refunded: U128,
    pub reserved: U128,
    pub refund_destination: String,
    pub origin_asset: String,
    pub fulfilled: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestStatus {
    Approved,
    Escalated,
    Executed,
    Rejected,
}

impl RequestStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "Approved",
            Self::Escalated => "Escalated",
            Self::Executed => "Executed",
            Self::Rejected => "Rejected",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) enum RequestKind {
    Refund { order_ref: String },
    Payout { payee: AccountId, reference: String },
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub(crate) struct StoredRequest {
    pub(crate) amount: u128,
    pub(crate) status: RequestStatus,
    pub(crate) reserved_day: u64,
    pub(crate) kind: RequestKind,
    /// Set before the `ft_transfer` promise, so a second call cannot spend the same request.
    pub(crate) submitted: bool,
}

/// What `request_refund` and `request_payout` return. Amounts are not repeated here.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestOutcome {
    pub request_id: U64,
    pub status: String,
}

/// JSON view of a stored request.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestView {
    pub request_id: U64,
    pub status: String,
    pub amount: U128,
    pub order_ref: Option<String>,
    pub payee: Option<String>,
    pub reference: Option<String>,
    pub submitted: bool,
}

/// The caps currently stored. Both values are JSON strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub per_tx: U128,
    pub daily: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner_id: AccountId,
    pub(crate) operator_id: AccountId,
    usdc_token_id: AccountId,
    pub(crate) caps: Caps,
    pub(crate) window: DayWindow,
    pub(crate) paused: bool,
    pub(crate) orders: LookupMap<String, StoredOrder>,
    pub(crate) requests: LookupMap<u64, StoredRequest>,
    pub(crate) payees: LookupSet<AccountId>,
    next_request_id: u64,
}

/// Gas for the USDC `ft_transfer`. The callback has its own budget.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
/// Gas for the private callback that commits or releases the reservation.
const TRANSFER_CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        operator_id: AccountId,
        usdc_token_id: AccountId,
        per_tx_cap: U128,
        daily_cap: U128,
    ) -> Self {
        Self {
            owner_id,
            operator_id,
            usdc_token_id,
            caps: Caps {
                per_tx: per_tx_cap.0,
                daily: daily_cap.0,
            },
            window: DayWindow::default(),
            paused: false,
            orders: LookupMap::new(StorageKey::Orders),
            requests: LookupMap::new(StorageKey::Requests),
            payees: LookupSet::new(StorageKey::Payees),
            next_request_id: 1,
        }
    }

    pub fn register_payment(
        &mut self,
        order_ref: String,
        amount_received: U128,
        refund_destination: String,
        origin_asset: String,
    ) {
        self.assert_operator();
        if self.paused {
            reject(PolicyError::Paused);
        }
        let amount = amount_received.0;
        if let Some(existing) = self.orders.get(&order_ref) {
            let same = existing.amount_received == amount
                && existing.refund_destination == refund_destination
                && existing.origin_asset == origin_asset;
            if same {
                return;
            }
            reject(PolicyError::OrderConflict);
        }
        self.orders.insert(
            order_ref,
            StoredOrder {
                amount_received: amount,
                refunded: 0,
                reserved: 0,
                refund_destination,
                origin_asset,
                fulfilled: false,
            },
        );
    }

    pub fn mark_fulfilled(&mut self, order_ref: String) {
        self.assert_operator();
        let Some(order) = self.orders.get_mut(&order_ref) else {
            reject(PolicyError::UnknownOrder);
        };
        order.fulfilled = true;
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn request_refund(&mut self, order_ref: String, amount: U128) -> RequestOutcome {
        self.assert_operator();
        if self.paused {
            reject(PolicyError::Paused);
        }
        let value = amount.0;
        let new_reserved = {
            let Some(order) = self.orders.get(&order_ref) else {
                reject(PolicyError::UnknownOrder);
            };
            let state = OrderRefundState {
                received: order.amount_received,
                refunded: order.refunded,
                reserved: order.reserved,
                fulfilled: order.fulfilled,
            };
            if let Err(err) = check_refund(&state, value) {
                reject(err);
            }
            match state.reserved.checked_add(value) {
                Some(sum) => sum,
                None => reject(PolicyError::Overflow),
            }
        };
        let outcome = self.store_request(
            value,
            RequestKind::Refund {
                order_ref: order_ref.clone(),
            },
        );
        let Some(stored) = self.orders.get_mut(&order_ref) else {
            reject(PolicyError::UnknownOrder);
        };
        stored.reserved = new_reserved;
        outcome
    }

    pub fn request_payout(
        &mut self,
        payee: AccountId,
        amount: U128,
        reference: String,
    ) -> RequestOutcome {
        self.assert_operator();
        if self.paused {
            reject(PolicyError::Paused);
        }
        if !self.payees.contains(&payee) {
            reject(PolicyError::PayeeNotAllowed);
        }
        self.store_request(amount.0, RequestKind::Payout { payee, reference })
    }

    pub fn approve_request(&mut self, request_id: U64) {
        self.assert_owner();
        let Some(request) = self.requests.get_mut(&request_id.0) else {
            reject(PolicyError::NotEscalated);
        };
        if request.status != RequestStatus::Escalated {
            reject(PolicyError::NotEscalated);
        }
        request.status = RequestStatus::Approved;
    }

    pub fn reject_request(&mut self, request_id: U64) {
        self.assert_owner();
        let (amount, reserved_day, kind) = {
            let Some(current) = self.requests.get(&request_id.0) else {
                reject(PolicyError::NotEscalated);
            };
            if current.status != RequestStatus::Escalated {
                reject(PolicyError::NotEscalated);
            }
            (current.amount, current.reserved_day, current.kind.clone())
        };
        self.window = release(self.window, reserved_day, amount);
        if let RequestKind::Refund { order_ref } = &kind {
            if let Some(order) = self.orders.get_mut(order_ref) {
                order.reserved = order.reserved.saturating_sub(amount);
            }
        }
        let Some(request) = self.requests.get_mut(&request_id.0) else {
            reject(PolicyError::NotEscalated);
        };
        request.status = RequestStatus::Rejected;
    }

    pub fn add_payee(&mut self, payee: AccountId) {
        self.assert_owner();
        self.payees.insert(payee);
    }

    pub fn remove_payee(&mut self, payee: AccountId) {
        self.assert_owner();
        self.payees.remove(&payee);
    }

    pub fn execute_refund(&mut self, request_id: U64, deposit_address: AccountId) -> Promise {
        let request = self.prepared(request_id.0);
        if !matches!(request.kind, RequestKind::Refund { .. }) {
            reject(PolicyError::NotApproved);
        }
        self.mark_submitted(request_id.0);
        let transfer = self.ft_transfer(deposit_address, request.amount);
        transfer.then(self.refund_callback(request_id))
    }

    pub fn execute_payout(&mut self, request_id: U64) -> Promise {
        let request = self.prepared(request_id.0);
        let amount = request.amount;
        let RequestKind::Payout { payee, .. } = request.kind else {
            reject(PolicyError::NotApproved);
        };
        self.mark_submitted(request_id.0);
        let transfer = self.ft_transfer(payee, amount);
        transfer.then(self.payout_callback(request_id))
    }

    /// Private because only the contract's own callback receipt may commit or release.
    /// The unit tests call this directly, so the predecessor check also lives in the body.
    /// The generated export repeats it for on-chain calls.
    #[private]
    pub fn on_refund_transfer(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        self.assert_callback_caller();
        self.settle_transfer(request_id.0, result.is_ok());
    }

    #[private]
    pub fn on_payout_transfer(
        &mut self,
        request_id: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        self.assert_callback_caller();
        self.settle_transfer(request_id.0, result.is_ok());
    }

    pub fn set_caps(&mut self, per_tx_cap: U128, daily_cap: U128) {
        self.assert_owner();
        self.caps = Caps {
            per_tx: per_tx_cap.0,
            daily: daily_cap.0,
        };
    }

    /// Decide and reserve, then store the request. Does not touch an order.
    fn store_request(&mut self, amount: u128, kind: RequestKind) -> RequestOutcome {
        let today = utc_day(env::block_timestamp());
        let decision = match decide(self.caps, self.window, today, amount) {
            Ok(decision) => decision,
            Err(err) => reject(err),
        };
        let window = match reserve(self.window, today, amount) {
            Ok(window) => window,
            Err(err) => reject(err),
        };
        let id = self.next_request_id;
        self.next_request_id = match id.checked_add(1) {
            Some(next) => next,
            None => reject(PolicyError::Overflow),
        };
        self.window = window;
        self.requests.insert(
            id,
            StoredRequest {
                amount,
                status: status_of(decision),
                reserved_day: today,
                kind,
                submitted: false,
            },
        );
        RequestOutcome {
            request_id: U64(id),
            status: status_of(decision).as_str().to_string(),
        }
    }

    fn assert_operator(&self) {
        self.assert_caller(&self.operator_id, PolicyError::NotOperator);
    }

    fn assert_owner(&self) {
        self.assert_caller(&self.owner_id, PolicyError::NotOwner);
    }

    fn assert_caller(&self, allowed: &AccountId, err: PolicyError) {
        if &env::predecessor_account_id() != allowed {
            reject(err);
        }
    }

    /// Load an approved request that has not been submitted. Does not mark it submitted.
    fn prepared(&self, id: u64) -> StoredRequest {
        let Some(request) = self.requests.get(&id) else {
            reject(PolicyError::NotApproved);
        };
        if request.submitted || request.status == RequestStatus::Executed {
            reject(PolicyError::AlreadyExecuted);
        }
        if request.status != RequestStatus::Approved {
            reject(PolicyError::NotApproved);
        }
        request.clone()
    }

    fn mark_submitted(&mut self, id: u64) {
        let Some(request) = self.requests.get_mut(&id) else {
            reject(PolicyError::NotApproved);
        };
        request.submitted = true;
    }

    fn ft_transfer(&self, receiver: AccountId, amount: u128) -> Promise {
        ext_ft::ext(self.usdc_token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(receiver, U128(amount), None)
    }

    fn refund_callback(&self, request_id: U64) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(TRANSFER_CALLBACK_GAS)
            .on_refund_transfer(request_id)
    }

    fn payout_callback(&self, request_id: U64) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(TRANSFER_CALLBACK_GAS)
            .on_payout_transfer(request_id)
    }

    fn assert_callback_caller(&self) {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("Method is private");
        }
    }

    fn settle_transfer(&mut self, request_id: u64, succeeded: bool) {
        let Some(current) = self.requests.get(&request_id) else {
            reject(PolicyError::NotApproved);
        };
        let amount = current.amount;
        let reserved_day = current.reserved_day;
        let kind = current.kind.clone();
        if succeeded {
            {
                let Some(request) = self.requests.get_mut(&request_id) else {
                    reject(PolicyError::NotApproved);
                };
                request.status = RequestStatus::Executed;
            }
            match kind {
                RequestKind::Refund { order_ref } => {
                    self.commit_refund(&order_ref, amount);
                    crate::events::refund_executed(request_id, amount, &order_ref);
                }
                RequestKind::Payout { payee, .. } => {
                    crate::events::payout_executed(request_id, amount, payee.as_str());
                }
            }
        } else {
            self.window = release(self.window, reserved_day, amount);
            match kind {
                RequestKind::Refund { order_ref } => {
                    if let Some(order) = self.orders.get_mut(&order_ref) {
                        order.reserved = order.reserved.saturating_sub(amount);
                    }
                    crate::events::refund_failed(request_id, amount, &order_ref);
                }
                RequestKind::Payout { payee, .. } => {
                    crate::events::payout_failed(request_id, amount, payee.as_str());
                }
            }
        }
    }

    fn commit_refund(&mut self, order_ref: &str, amount: u128) {
        let Some(order) = self.orders.get_mut(order_ref) else {
            reject(PolicyError::UnknownOrder);
        };
        order.refunded = match order.refunded.checked_add(amount) {
            Some(sum) => sum,
            None => reject(PolicyError::Overflow),
        };
        order.reserved = order.reserved.saturating_sub(amount);
    }
}

fn status_of(decision: Decision) -> RequestStatus {
    match decision {
        Decision::Approved => RequestStatus::Approved,
        Decision::Escalated => RequestStatus::Escalated,
    }
}

impl Order {
    pub(crate) fn from_stored(order: &StoredOrder) -> Self {
        Self {
            amount_received: U128(order.amount_received),
            refunded: U128(order.refunded),
            reserved: U128(order.reserved),
            refund_destination: order.refund_destination.clone(),
            origin_asset: order.origin_asset.clone(),
            fulfilled: order.fulfilled,
        }
    }
}

/// A failed call panics with the stable code and no other text.
fn reject(err: PolicyError) -> ! {
    env::panic_str(err.code());
}

impl BorshSerialize for Caps {
    fn serialize<W: Write>(&self, writer: &mut W) -> BorshResult<()> {
        self.per_tx.serialize(writer)?;
        self.daily.serialize(writer)
    }
}

impl BorshDeserialize for Caps {
    fn deserialize_reader<R: Read>(reader: &mut R) -> BorshResult<Self> {
        Ok(Self {
            per_tx: u128::deserialize_reader(reader)?,
            daily: u128::deserialize_reader(reader)?,
        })
    }
}

impl BorshSerialize for DayWindow {
    fn serialize<W: Write>(&self, writer: &mut W) -> BorshResult<()> {
        self.day.serialize(writer)?;
        self.spent.serialize(writer)
    }
}

impl BorshDeserialize for DayWindow {
    fn deserialize_reader<R: Read>(reader: &mut R) -> BorshResult<Self> {
        Ok(Self {
            day: u64::deserialize_reader(reader)?,
            spent: u128::deserialize_reader(reader)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const OWNER: &str = "owner.near";
    const OPERATOR: &str = "operator.near";
    const USDC: &str = "usdc.near";
    const ORDER_REF: &str = "pay-1";
    const REFUND: &str = "TCustomerRefundAddress";
    const ASSET: &str = "nep141:tron-usdt";
    const AMOUNT: u128 = 1_000_000;

    fn account(name: &str) -> AccountId {
        name.parse().expect("account id")
    }

    fn as_predecessor(name: &str) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(account(name))
            .build();
        testing_env!(context);
    }

    fn new_contract() -> Contract {
        as_predecessor(OWNER);
        Contract::new(
            account(OWNER),
            account(OPERATOR),
            account(USDC),
            U128(50_000_000),
            U128(200_000_000),
        )
    }

    fn register(contract: &mut Contract, amount: u128) {
        as_predecessor(OPERATOR);
        contract.register_payment(
            ORDER_REF.to_string(),
            U128(amount),
            REFUND.to_string(),
            ASSET.to_string(),
        );
    }

    #[test]
    fn get_order_is_null_before_registration_and_returns_the_stored_order_after() {
        let mut contract = new_contract();
        assert!(contract.get_order(ORDER_REF.to_string()).is_none());
        register(&mut contract, AMOUNT);
        assert_eq!(
            contract.get_order(ORDER_REF.to_string()),
            Some(Order {
                amount_received: U128(AMOUNT),
                refunded: U128(0),
                reserved: U128(0),
                refund_destination: REFUND.to_string(),
                origin_asset: ASSET.to_string(),
                fulfilled: false,
            }),
        );
    }

    #[test]
    fn identical_replay_after_mark_fulfilled_stays_fulfilled() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OPERATOR);
        contract.mark_fulfilled(ORDER_REF.to_string());
        register(&mut contract, AMOUNT);
        let order = contract.get_order(ORDER_REF.to_string()).expect("order");
        assert!(order.fulfilled);
        assert_eq!(order.refunded, U128(0));
        assert_eq!(order.reserved, U128(0));
        assert_eq!(order.amount_received, U128(AMOUNT));
    }

    #[test]
    #[should_panic(expected = "E_NOT_OPERATOR")]
    fn register_payment_rejects_a_non_operator() {
        let mut contract = new_contract();
        as_predecessor("alice.near");
        contract.register_payment(
            ORDER_REF.to_string(),
            U128(AMOUNT),
            REFUND.to_string(),
            ASSET.to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "E_PAUSED")]
    fn register_payment_rejects_while_paused() {
        let mut contract = new_contract();
        as_predecessor(OWNER);
        contract.pause();
        register(&mut contract, AMOUNT);
    }

    #[test]
    #[should_panic(expected = "E_ORDER_CONFLICT")]
    fn register_payment_rejects_a_different_amount() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        register(&mut contract, AMOUNT + 1);
    }

    #[test]
    #[should_panic(expected = "E_UNKNOWN_ORDER")]
    fn mark_fulfilled_rejects_an_unknown_order() {
        let mut contract = new_contract();
        as_predecessor(OPERATOR);
        contract.mark_fulfilled(ORDER_REF.to_string());
    }

    #[test]
    #[should_panic(expected = "E_NOT_OPERATOR")]
    fn mark_fulfilled_rejects_the_owner() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OWNER);
        contract.mark_fulfilled(ORDER_REF.to_string());
    }

    #[test]
    fn mark_fulfilled_succeeds_while_paused_and_a_second_call_stays_fulfilled() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OWNER);
        contract.pause();
        as_predecessor(OPERATOR);
        contract.mark_fulfilled(ORDER_REF.to_string());
        contract.mark_fulfilled(ORDER_REF.to_string());
        let order = contract.get_order(ORDER_REF.to_string()).expect("order");
        assert!(order.fulfilled);
    }

    #[test]
    #[should_panic(expected = "E_NOT_OWNER")]
    fn pause_rejects_the_operator() {
        let mut contract = new_contract();
        as_predecessor(OPERATOR);
        contract.pause();
    }

    #[test]
    #[should_panic(expected = "E_NOT_OWNER")]
    fn unpause_rejects_the_operator() {
        let mut contract = new_contract();
        as_predecessor(OWNER);
        contract.pause();
        as_predecessor(OPERATOR);
        contract.unpause();
    }

    #[test]
    fn owner_pause_and_unpause_are_idempotent_and_unpause_allows_registration() {
        let mut contract = new_contract();
        as_predecessor(OWNER);
        contract.pause();
        contract.pause();
        contract.unpause();
        contract.unpause();
        register(&mut contract, AMOUNT);
        assert!(contract.get_order(ORDER_REF.to_string()).is_some());
    }

    fn refund(contract: &mut Contract, amount: u128) -> RequestOutcome {
        as_predecessor(OPERATOR);
        contract.request_refund(ORDER_REF.to_string(), U128(amount))
    }

    #[test]
    fn an_in_cap_refund_is_approved_and_an_over_cap_refund_is_escalated() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let approved = refund(&mut contract, AMOUNT);
        assert_eq!(approved.status, "Approved");
        assert_eq!(contract.get_day_spend(), U128(AMOUNT));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(AMOUNT)
        );

        let escalated = refund(&mut contract, 50_000_001);
        assert_eq!(escalated.status, "Escalated");
        assert_eq!(contract.get_day_spend(), U128(AMOUNT + 50_000_001));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(AMOUNT + 50_000_001),
        );
    }

    #[test]
    #[should_panic(expected = "E_ZERO_AMOUNT")]
    fn a_zero_refund_is_rejected() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        refund(&mut contract, 0);
    }

    #[test]
    #[should_panic(expected = "E_FULFILLED")]
    fn a_fulfilled_order_cannot_be_refunded() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OPERATOR);
        contract.mark_fulfilled(ORDER_REF.to_string());
        refund(&mut contract, AMOUNT);
    }

    #[test]
    #[should_panic(expected = "E_AMOUNT_EXCEEDS_RECEIVED")]
    fn a_refund_above_the_remainder_is_rejected() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        refund(&mut contract, AMOUNT + 1);
    }

    #[test]
    #[should_panic(expected = "E_UNKNOWN_ORDER")]
    fn a_refund_for_an_unknown_order_is_rejected() {
        let mut contract = new_contract();
        refund(&mut contract, AMOUNT);
    }

    #[test]
    #[should_panic(expected = "E_NOT_OPERATOR")]
    fn a_refund_rejects_the_owner() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OWNER);
        contract.request_refund(ORDER_REF.to_string(), U128(AMOUNT));
    }

    #[test]
    #[should_panic(expected = "E_PAUSED")]
    fn a_refund_is_rejected_while_paused() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        as_predecessor(OWNER);
        contract.pause();
        refund(&mut contract, AMOUNT);
    }

    #[test]
    fn a_payout_does_not_touch_an_order_reserved_amount() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        let payee = account("payee.near");
        as_predecessor(OWNER);
        contract.add_payee(payee.clone());
        contract.add_payee(payee.clone());
        as_predecessor(OPERATOR);
        let outcome = contract.request_payout(payee, U128(AMOUNT), "ref-1".to_string());
        assert_eq!(outcome.status, "Approved");
        assert_eq!(contract.get_day_spend(), U128(AMOUNT));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(0)
        );
    }

    #[test]
    #[should_panic(expected = "E_PAYEE_NOT_ALLOWED")]
    fn a_payout_to_an_unknown_payee_is_rejected() {
        let mut contract = new_contract();
        as_predecessor(OPERATOR);
        contract.request_payout(account("payee.near"), U128(AMOUNT), "ref-1".to_string());
    }

    #[test]
    #[should_panic(expected = "E_ZERO_AMOUNT")]
    fn a_zero_payout_to_an_allowlisted_payee_is_rejected() {
        let mut contract = new_contract();
        let payee = account("payee.near");
        as_predecessor(OWNER);
        contract.add_payee(payee.clone());
        as_predecessor(OPERATOR);
        contract.request_payout(payee, U128(0), "ref-0".to_string());
    }

    #[test]
    fn approve_does_not_reserve_again_and_a_second_approve_fails() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let outcome = refund(&mut contract, 50_000_001);
        assert_eq!(outcome.status, "Escalated");
        let spent = contract.get_day_spend();
        as_predecessor(OWNER);
        contract.approve_request(outcome.request_id);
        assert_eq!(contract.get_day_spend(), spent);
        let stored = contract.get_request(outcome.request_id).expect("request");
        assert_eq!(stored.status, "Approved");
    }

    #[test]
    #[should_panic(expected = "E_NOT_ESCALATED")]
    fn approving_twice_is_rejected() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let outcome = refund(&mut contract, 50_000_001);
        as_predecessor(OWNER);
        contract.approve_request(outcome.request_id);
        contract.approve_request(outcome.request_id);
    }

    #[test]
    #[should_panic(expected = "E_NOT_OWNER")]
    fn the_operator_cannot_approve() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let outcome = refund(&mut contract, 50_000_001);
        as_predecessor(OPERATOR);
        contract.approve_request(outcome.request_id);
    }

    #[test]
    fn reject_frees_today_and_still_frees_reserved_after_the_day_rolls() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let outcome = refund(&mut contract, 50_000_001);
        as_predecessor(OWNER);
        contract.reject_request(outcome.request_id);
        assert_eq!(contract.get_day_spend(), U128(0));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(0)
        );
        assert_eq!(
            contract
                .get_request(outcome.request_id)
                .expect("request")
                .status,
            "Rejected"
        );

        let again = refund(&mut contract, 50_000_001);
        as_predecessor_at(OWNER, crate::policy::NANOS_PER_DAY);
        assert_eq!(contract.get_day_spend(), U128(0));
        contract.reject_request(again.request_id);
        assert_eq!(contract.get_day_spend(), U128(0));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(0)
        );
    }

    #[test]
    fn get_request_and_get_limits_follow_what_was_stored() {
        let mut contract = new_contract();
        assert!(contract.get_request(U64(1)).is_none());
        assert_eq!(
            contract.get_limits(),
            Limits {
                per_tx: U128(50_000_000),
                daily: U128(200_000_000),
            },
        );
        register(&mut contract, AMOUNT);
        let outcome = refund(&mut contract, AMOUNT);
        let stored = contract.get_request(outcome.request_id).expect("request");
        assert_eq!(stored.request_id, U64(1));
        assert_eq!(stored.status, "Approved");
        assert_eq!(stored.amount, U128(AMOUNT));
        as_predecessor(OWNER);
        contract.set_caps(U128(7), U128(9));
        assert_eq!(
            contract.get_limits(),
            Limits {
                per_tx: U128(7),
                daily: U128(9)
            }
        );
    }

    #[test]
    #[should_panic(expected = "E_NOT_OWNER")]
    fn the_operator_cannot_set_caps() {
        let mut contract = new_contract();
        as_predecessor(OPERATOR);
        contract.set_caps(U128(1), U128(1));
    }

    #[test]
    #[should_panic(expected = "E_OVERFLOW")]
    fn a_payout_that_overflows_the_day_is_rejected() {
        let mut contract = new_contract();
        let payee = account("payee.near");
        as_predecessor(OWNER);
        contract.set_caps(U128(u128::MAX), U128(u128::MAX));
        contract.add_payee(payee.clone());
        as_predecessor(OPERATOR);
        contract.request_payout(payee.clone(), U128(u128::MAX - 1), "big".to_string());
        contract.request_payout(payee, U128(2), "overflow".to_string());
    }

    const DEPOSIT: &str = "deposit.near";

    fn approved_refund(contract: &mut Contract) -> RequestOutcome {
        register(contract, AMOUNT);
        refund(contract, AMOUNT)
    }

    fn usdc_transfers() -> Vec<near_sdk::mock::Receipt> {
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .filter(|receipt| receipt.receiver_id == account(USDC))
            .filter(|receipt| {
                receipt.actions.iter().any(|action| {
                    matches!(
                        action,
                        near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. }
                            if method_name == b"ft_transfer"
                    )
                })
            })
            .collect()
    }

    fn as_contract() {
        let id = account("policy.near");
        let context = VMContextBuilder::new()
            .current_account_id(id.clone())
            .predecessor_account_id(id)
            .build();
        testing_env!(context);
    }

    #[test]
    fn an_approved_refund_creates_one_usdc_transfer_and_a_repeat_does_not() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OPERATOR);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
        let transfers = usdc_transfers();
        assert_eq!(transfers.len(), 1);
        let deposit = transfers[0].actions.iter().find_map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                attached_deposit, ..
            } => Some(*attached_deposit),
            _ => None,
        });
        assert_eq!(deposit, Some(near_sdk::NearToken::from_yoctonear(1)));
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.execute_refund(outcome.request_id, account(DEPOSIT));
        }));
        let message = caught.expect_err("repeat must panic");
        let text = panic_text(message.as_ref());
        assert!(text.contains("E_ALREADY_EXECUTED"), "{text}");
        assert_eq!(usdc_transfers().len(), 1);
    }

    #[test]
    fn a_refund_success_callback_moves_reserved_to_refunded_and_keeps_the_day() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OPERATOR);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
        as_contract();
        contract.on_refund_transfer(outcome.request_id, Ok(()));
        let order = contract.get_order(ORDER_REF.to_string()).expect("order");
        assert_eq!(order.reserved, U128(0));
        assert_eq!(order.refunded, U128(AMOUNT));
        assert_eq!(contract.get_day_spend(), U128(AMOUNT));
        let stored = contract.get_request(outcome.request_id).expect("request");
        assert_eq!(stored.status, "Executed");
        assert!(stored.submitted);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|line| { line.starts_with("EVENT_JSON:") && line.contains("refund_executed") }));
    }

    #[test]
    fn a_refund_failure_callback_releases_the_reservation_and_cannot_execute_again() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OPERATOR);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
        as_contract();
        contract.on_refund_transfer(outcome.request_id, Err(PromiseError::Failed));
        let order = contract.get_order(ORDER_REF.to_string()).expect("order");
        assert_eq!(order.reserved, U128(0));
        assert_eq!(order.refunded, U128(0));
        assert_eq!(contract.get_day_spend(), U128(0));
        let stored = contract.get_request(outcome.request_id).expect("request");
        assert_eq!(stored.status, "Approved");
        assert!(stored.submitted);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|line| line.starts_with("EVENT_JSON:") && line.contains("refund_failed")));
        as_predecessor(OPERATOR);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.execute_refund(outcome.request_id, account(DEPOSIT));
        }));
        assert!(panic_text(caught.expect_err("repeat").as_ref()).contains("E_ALREADY_EXECUTED"));
    }

    #[test]
    fn a_payout_success_leaves_orders_untouched_and_a_failure_releases_only_the_day() {
        let mut contract = new_contract();
        register(&mut contract, AMOUNT);
        let payee = account("payee.near");
        as_predecessor(OWNER);
        contract.add_payee(payee.clone());
        as_predecessor(OPERATOR);
        let outcome = contract.request_payout(payee, U128(AMOUNT), "ref-1".to_string());
        contract.execute_payout(outcome.request_id);
        as_contract();
        contract.on_payout_transfer(outcome.request_id, Ok(()));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(0)
        );
        assert_eq!(contract.get_day_spend(), U128(AMOUNT));
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|line| line.starts_with("EVENT_JSON:") && line.contains("payout_executed")));

        as_predecessor(OPERATOR);
        let second =
            contract.request_payout(account("payee.near"), U128(AMOUNT), "ref-2".to_string());
        contract.execute_payout(second.request_id);
        as_contract();
        contract.on_payout_transfer(second.request_id, Err(PromiseError::Failed));
        assert_eq!(
            contract
                .get_order(ORDER_REF.to_string())
                .expect("order")
                .reserved,
            U128(0)
        );
        assert_eq!(contract.get_day_spend(), U128(AMOUNT));
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|line| line.starts_with("EVENT_JSON:") && line.contains("payout_failed")));
    }

    #[test]
    fn pause_does_not_block_an_approved_refund() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OWNER);
        contract.pause();
        as_predecessor(OPERATOR);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
        assert_eq!(usdc_transfers().len(), 1);
    }

    #[test]
    #[should_panic(expected = "E_NOT_OPERATOR")]
    fn the_owner_cannot_execute_a_refund() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OWNER);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
    }

    #[test]
    #[should_panic(expected = "E_NOT_APPROVED")]
    fn an_escalated_refund_cannot_be_executed() {
        let mut contract = new_contract();
        register(&mut contract, 100_000_000);
        let outcome = refund(&mut contract, 50_000_001);
        as_predecessor(OPERATOR);
        contract.execute_refund(outcome.request_id, account(DEPOSIT));
    }

    #[test]
    #[should_panic(expected = "E_NOT_APPROVED")]
    fn a_missing_request_cannot_be_executed() {
        let mut contract = new_contract();
        as_predecessor(OPERATOR);
        contract.execute_refund(U64(99), account(DEPOSIT));
    }

    #[test]
    #[should_panic(expected = "Method is private")]
    fn a_callback_from_another_account_is_rejected() {
        let mut contract = new_contract();
        let outcome = approved_refund(&mut contract);
        as_predecessor(OPERATOR);
        contract.on_refund_transfer(outcome.request_id, Ok(()));
    }

    fn panic_text(message: &(dyn std::any::Any + Send)) -> String {
        message
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| {
                message
                    .downcast_ref::<&str>()
                    .map(|value| (*value).to_string())
            })
            .unwrap_or_default()
    }

    fn as_predecessor_at(name: &str, timestamp: u64) {
        let context = VMContextBuilder::new()
            .predecessor_account_id(account(name))
            .block_timestamp(timestamp)
            .build();
        testing_env!(context);
    }
}
