//! Fungible token stand-in. `ft_transfer` succeeds unless the receiver is `fail.near`.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {}

#[near]
impl MockFt {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    /// Payable because the policy attaches 1 yoctoNEAR. The amount and memo are part of
    /// the transfer ABI and are otherwise unused.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let _ = (amount, memo);
        if receiver_id.as_str() == "fail.near" {
            env::panic_str("ft_transfer failed");
        }
    }
}
