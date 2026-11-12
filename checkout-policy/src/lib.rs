//! checkout-policy: treasury and spending guard for Intents Checkout.

pub mod errors;
pub mod events;
pub mod policy;
pub mod views;

use near_sdk::borsh::io::{Read, Result as BorshResult, Write};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

use crate::errors::PolicyError;
use crate::policy::{Caps, DayWindow};

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Orders,
}

/// One registered payment. Amounts are base units. Borsh stores the `u128` values.
#[near(serializers = [borsh])]
#[derive(Clone)]
struct StoredOrder {
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    operator_id: AccountId,
    usdc_token_id: AccountId,
    caps: Caps,
    window: DayWindow,
    paused: bool,
    orders: LookupMap<String, StoredOrder>,
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

    pub fn get_order(&self, order_ref: String) -> Option<Order> {
        self.orders.get(&order_ref).map(Order::from_stored)
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
}

impl Order {
    fn from_stored(order: &StoredOrder) -> Self {
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
}
