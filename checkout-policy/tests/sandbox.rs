//! Sandbox coverage for the treasury contract.
//!
//! One worker deploys this contract and a mock fungible token. The wasm32 target
//! builds both into `target/sandbox-wasm` first, so the test process does not
//! lock the package build directory. A rejection is a failed transaction whose
//! error text contains the stable code. Overflow stays in the in-process unit tests.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Context;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const DEST: &str = "TRefundDest";
const ASSET: &str = "nep141:usdc.near";
const PAYEE: &str = "payee.test.near";
const CUSTOMER: &str = "customer.near";
const FAIL: &str = "fail.near";

const PER_TX: u128 = 50_000_000;
const DAILY: u128 = 200_000_000;
const SMALL: u128 = 1_000_000;
const OVER_TX: u128 = PER_TX + 1;
const RECEIVED: u128 = 10_000_000;
const RECEIVED_LARGE: u128 = 100_000_000;

const REG_SAME: &str = "reg-same";
const REG_OWNER: &str = "reg-owner";
const REG_PAUSED: &str = "reg-paused";
const FULFIL_MISSING: &str = "fulfil-missing";
const FULFIL_OWNER: &str = "fulfil-owner";
const FULFIL_DONE: &str = "fulfil-done";
const REFUND_ZERO: &str = "refund-zero";
const REFUND_UNKNOWN: &str = "refund-unknown";
const REFUND_OVER: &str = "refund-over";
const REFUND_OK: &str = "refund-ok";
const REFUND_ESC: &str = "refund-esc";
const REFUND_APPROVE: &str = "refund-approve";
const REFUND_REJECT: &str = "refund-reject";
const REFUND_FAIL: &str = "refund-fail";
const REFUND_OWNER_EXEC: &str = "refund-owner-exec";
const REFUND_PAUSE: &str = "refund-pause";
const REFUND_UNPAUSE: &str = "refund-unpause";

struct RefundIds {
    approved: String,
    escalated: String,
}

struct World {
    _worker: Worker<Sandbox>,
    owner: Account,
    operator: Account,
    policy: Contract,
    ft: AccountId,
}

#[tokio::test]
async fn policy_sandbox() -> anyhow::Result<()> {
    let world = deploy().await?;
    register_payments(&world).await?;
    mark_fulfilled(&world).await?;
    let refunds = request_refunds(&world).await?;
    let payout = request_payouts(&world).await?;
    let _approved_escalation = approve_request(&world).await?;
    reject_request(&world, &refunds.approved).await?;
    let failed_refund = execute_refund_success_and_failure(&world, &refunds.approved).await?;
    execute_again(&world, &refunds.approved, &failed_refund).await?;
    owner_and_escalated_execute(&world, &refunds.escalated).await?;
    execute_payouts(&world, &payout).await?;
    pause_and_unpause(&world).await?;
    operator_cannot_administer(&world).await?;
    views(&world, REFUND_OK, &refunds.approved).await?;
    Ok(())
}

async fn deploy() -> anyhow::Result<World> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let policy_wasm = compile_wasm(&root.join("Cargo.toml"), "checkout_policy.wasm")?;
    let ft_wasm = compile_wasm(&root.join("tests/mock-ft/Cargo.toml"), "mock_ft.wasm")?;

    let worker = near_workspaces::sandbox().await?;
    let root_account = worker.root_account()?;
    let owner = root_account
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let operator = root_account
        .create_subaccount("operator")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let owner_id = owner.id().to_string();
    let operator_id = operator.id().to_string();
    anyhow::ensure!(owner_id == "owner.test.near", "owner account is {owner_id}");
    anyhow::ensure!(
        operator_id == "operator.test.near",
        "operator account is {operator_id}"
    );

    let ft = worker.dev_deploy(&ft_wasm).await?;
    accepted(
        ft.call("new")
            .max_gas()
            .transact()
            .await
            .context("init mock ft")?,
    )?;
    let policy = worker.dev_deploy(&policy_wasm).await?;
    let balance = policy.view_account().await?.balance;
    anyhow::ensure!(
        balance >= NearToken::from_yoctonear(1),
        "policy account balance {balance:?} cannot attach 1 yoctoNEAR"
    );
    accepted(
        policy
            .call("new")
            .args_json(json!({
                "owner_id": owner.id(),
                "operator_id": operator.id(),
                "usdc_token_id": ft.id(),
                "per_tx_cap": PER_TX.to_string(),
                "daily_cap": DAILY.to_string(),
            }))
            .max_gas()
            .transact()
            .await
            .context("init policy")?,
    )?;

    Ok(World {
        _worker: worker,
        owner,
        operator,
        ft: ft.id().clone(),
        policy,
    })
}

fn compile_wasm(manifest: &Path, file_name: &str) -> anyhow::Result<Vec<u8>> {
    let target_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/sandbox-wasm");
    let status = Command::new("cargo")
        .current_dir(manifest.parent().unwrap_or(manifest))
        // Without this, `env::panic_str` becomes a bare abort and the sandbox
        // reports `unreachable` instead of the E_* code.
        .env("RUSTFLAGS", "--cfg near")
        .arg("build")
        .arg("--manifest-path")
        .arg(manifest)
        .arg("--release")
        .arg("--target")
        .arg("wasm32-unknown-unknown")
        .arg("--target-dir")
        .arg(&target_dir)
        .status()
        .with_context(|| format!("start wasm build for {}", manifest.display()))?;
    anyhow::ensure!(
        status.success(),
        "wasm build failed for {}",
        manifest.display()
    );
    let wasm_path = target_dir
        .join("wasm32-unknown-unknown/release")
        .join(file_name);
    let wasm =
        std::fs::read(&wasm_path).with_context(|| format!("read {}", wasm_path.display()))?;
    anyhow::ensure!(!wasm.is_empty(), "empty wasm {}", wasm_path.display());
    Ok(wasm)
}

impl World {
    async fn call(
        &self,
        signer: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        let signer = signer.clone();
        let policy_id = self.policy.id().clone();
        signer
            .call(&policy_id, method)
            .args_json(args)
            .max_gas()
            .transact()
            .await
            .with_context(|| format!("transact {method}"))
    }

    async fn operator_call(
        &self,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.call(&self.operator, method, args).await
    }

    async fn owner_call(&self, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        self.call(&self.owner, method, args).await
    }

    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        let operator = self.operator.clone();
        let policy_id = self.policy.id().clone();
        operator
            .call(&policy_id, method)
            .args_json(args)
            .view()
            .await
            .with_context(|| format!("view {method}"))?
            .json()
            .with_context(|| format!("decode {method}"))
    }

    async fn register(&self, order_ref: &str, amount: u128) -> anyhow::Result<()> {
        accepted(self.registration(order_ref, amount).await?)
    }

    async fn registration(
        &self,
        order_ref: &str,
        amount: u128,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.operator_call(
            "register_payment",
            json!({
                "order_ref": order_ref,
                "amount_received": amount.to_string(),
                "refund_destination": DEST,
                "origin_asset": ASSET,
            }),
        )
        .await
    }

    async fn order(&self, order_ref: &str) -> anyhow::Result<Value> {
        let value = self
            .view("get_order", json!({ "order_ref": order_ref }))
            .await?;
        anyhow::ensure!(!value.is_null(), "missing order {order_ref}");
        Ok(value)
    }

    async fn expect_absent(&self, order_ref: &str) -> anyhow::Result<()> {
        let value = self
            .view("get_order", json!({ "order_ref": order_ref }))
            .await?;
        anyhow::ensure!(
            value.is_null(),
            "expected no order {order_ref}, got {value}"
        );
        Ok(())
    }

    async fn expect_balances(
        &self,
        order_ref: &str,
        reserved: u128,
        refunded: u128,
        fulfilled: bool,
    ) -> anyhow::Result<()> {
        let order = self.order(order_ref).await?;
        anyhow::ensure!(amount_field(&order, "reserved")? == reserved, "{order}");
        anyhow::ensure!(amount_field(&order, "refunded")? == refunded, "{order}");
        anyhow::ensure!(flag(&order, "fulfilled")? == fulfilled, "{order}");
        Ok(())
    }

    async fn request_view(&self, request_id: &str) -> anyhow::Result<Value> {
        let value = self
            .view("get_request", json!({ "request_id": request_id }))
            .await?;
        anyhow::ensure!(!value.is_null(), "missing request {request_id}");
        Ok(value)
    }

    async fn expect_request(
        &self,
        request_id: &str,
        status: &str,
        submitted: bool,
    ) -> anyhow::Result<()> {
        let request = self.request_view(request_id).await?;
        anyhow::ensure!(str_field(&request, "status")? == status, "{request}");
        anyhow::ensure!(flag(&request, "submitted")? == submitted, "{request}");
        Ok(())
    }

    async fn spend(&self) -> anyhow::Result<u128> {
        let value = self.view("get_day_spend", json!({})).await?;
        let text = value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("day spend {value}"))?;
        Ok(text.parse()?)
    }

    async fn refund(&self, order_ref: &str, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
        self.operator_call(
            "request_refund",
            json!({
                "order_ref": order_ref,
                "amount": amount.to_string(),
            }),
        )
        .await
    }

    async fn snapshot(&self, refs: &[&str]) -> anyhow::Result<Vec<Value>> {
        let mut orders = Vec::with_capacity(refs.len());
        for order_ref in refs {
            orders.push(self.order(order_ref).await?);
        }
        Ok(orders)
    }
}

async fn register_payments(world: &World) -> anyhow::Result<()> {
    accepted(world.registration(REG_SAME, SMALL).await?)?;
    accepted(world.registration(REG_SAME, SMALL).await?)?;
    let order = world.order(REG_SAME).await?;
    anyhow::ensure!(amount_field(&order, "amount_received")? == SMALL, "{order}");
    anyhow::ensure!(str_field(&order, "refund_destination")? == DEST, "{order}");
    anyhow::ensure!(str_field(&order, "origin_asset")? == ASSET, "{order}");
    world.expect_balances(REG_SAME, 0, 0, false).await?;

    must_fail(
        world.registration(REG_SAME, SMALL + 1).await?,
        "E_ORDER_CONFLICT",
    )?;
    anyhow::ensure!(amount_field(&world.order(REG_SAME).await?, "amount_received")? == SMALL);

    must_fail(
        world
            .owner_call(
                "register_payment",
                json!({
                    "order_ref": REG_OWNER,
                    "amount_received": SMALL.to_string(),
                    "refund_destination": DEST,
                    "origin_asset": ASSET,
                }),
            )
            .await?,
        "E_NOT_OPERATOR",
    )?;
    world.expect_absent(REG_OWNER).await?;

    accepted(world.owner_call("pause", json!({})).await?)?;
    must_fail(world.registration(REG_PAUSED, SMALL).await?, "E_PAUSED")?;
    world.expect_absent(REG_PAUSED).await?;
    accepted(world.owner_call("unpause", json!({})).await?)?;
    world.register(REG_PAUSED, SMALL).await?;
    world.expect_balances(REG_PAUSED, 0, 0, false).await?;
    Ok(())
}

async fn mark_fulfilled(world: &World) -> anyhow::Result<()> {
    must_fail(
        world
            .operator_call("mark_fulfilled", json!({ "order_ref": FULFIL_MISSING }))
            .await?,
        "E_UNKNOWN_ORDER",
    )?;
    world.register(FULFIL_OWNER, RECEIVED).await?;
    must_fail(
        world
            .owner_call("mark_fulfilled", json!({ "order_ref": FULFIL_OWNER }))
            .await?,
        "E_NOT_OPERATOR",
    )?;
    world.expect_balances(FULFIL_OWNER, 0, 0, false).await?;

    world.register(FULFIL_DONE, RECEIVED).await?;
    accepted(
        world
            .operator_call("mark_fulfilled", json!({ "order_ref": FULFIL_DONE }))
            .await?,
    )?;
    must_fail(world.refund(FULFIL_DONE, SMALL).await?, "E_FULFILLED")?;
    world.expect_balances(FULFIL_DONE, 0, 0, true).await?;
    Ok(())
}

async fn request_refunds(world: &World) -> anyhow::Result<RefundIds> {
    world.register(REFUND_ZERO, RECEIVED).await?;
    must_fail(world.refund(REFUND_ZERO, 0).await?, "E_ZERO_AMOUNT")?;
    world.expect_balances(REFUND_ZERO, 0, 0, false).await?;

    must_fail(
        world.refund(REFUND_UNKNOWN, SMALL).await?,
        "E_UNKNOWN_ORDER",
    )?;

    world.register(REFUND_OVER, RECEIVED).await?;
    must_fail(
        world.refund(REFUND_OVER, RECEIVED + 1).await?,
        "E_AMOUNT_EXCEEDS_RECEIVED",
    )?;
    world.expect_balances(REFUND_OVER, 0, 0, false).await?;

    let approved = approved_refund(world).await?;
    let escalated = escalated_refund(world).await?;
    Ok(RefundIds {
        approved,
        escalated,
    })
}

async fn approved_refund(world: &World) -> anyhow::Result<String> {
    world.register(REFUND_OK, RECEIVED).await?;
    let before = world.spend().await?;
    let result = world.refund(REFUND_OK, SMALL).await?;
    assert_no_ft(&result, &world.ft)?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    world.expect_request(&request_id, "Approved", false).await?;
    world.expect_balances(REFUND_OK, SMALL, 0, false).await?;
    anyhow::ensure!(world.spend().await? == before + SMALL);
    Ok(request_id)
}

async fn escalated_refund(world: &World) -> anyhow::Result<String> {
    world.register(REFUND_ESC, RECEIVED_LARGE).await?;
    let before = world.spend().await?;
    let result = world.refund(REFUND_ESC, OVER_TX).await?;
    assert_no_ft(&result, &world.ft)?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Escalated", "{status}");
    world
        .expect_request(&request_id, "Escalated", false)
        .await?;
    world.expect_balances(REFUND_ESC, OVER_TX, 0, false).await?;
    anyhow::ensure!(world.spend().await? == before + OVER_TX);
    Ok(request_id)
}

async fn request_payouts(world: &World) -> anyhow::Result<String> {
    must_fail(
        payout(world, PAYEE, SMALL, "payout-denied").await?,
        "E_PAYEE_NOT_ALLOWED",
    )?;
    accepted(
        world
            .owner_call("add_payee", json!({ "payee": PAYEE }))
            .await?,
    )?;
    must_fail(
        payout(world, PAYEE, 0, "payout-zero").await?,
        "E_ZERO_AMOUNT",
    )?;

    let before_orders = world
        .snapshot(&[REFUND_OK, REFUND_ESC, FULFIL_DONE])
        .await?;
    let before = world.spend().await?;
    let result = payout(world, PAYEE, SMALL, "payout-ok").await?;
    assert_no_ft(&result, &world.ft)?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    world.expect_request(&request_id, "Approved", false).await?;
    anyhow::ensure!(world.spend().await? == before + SMALL);
    anyhow::ensure!(
        world
            .snapshot(&[REFUND_OK, REFUND_ESC, FULFIL_DONE])
            .await?
            == before_orders
    );
    let request = world.request_view(&request_id).await?;
    anyhow::ensure!(request["order_ref"].is_null(), "{request}");
    anyhow::ensure!(str_field(&request, "payee")? == PAYEE, "{request}");
    anyhow::ensure!(
        str_field(&request, "reference")? == "payout-ok",
        "{request}"
    );
    Ok(request_id)
}

async fn payout(
    world: &World,
    payee: &str,
    amount: u128,
    reference: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    world
        .operator_call(
            "request_payout",
            json!({
                "payee": payee,
                "amount": amount.to_string(),
                "reference": reference,
            }),
        )
        .await
}

async fn approve_request(world: &World) -> anyhow::Result<String> {
    world.register(REFUND_APPROVE, RECEIVED_LARGE).await?;
    let result = world.refund(REFUND_APPROVE, OVER_TX).await?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Escalated", "{status}");
    let spent = world.spend().await?;
    let reserved = amount_field(&world.order(REFUND_APPROVE).await?, "reserved")?;

    must_fail(
        world
            .operator_call("approve_request", json!({ "request_id": request_id }))
            .await?,
        "E_NOT_OWNER",
    )?;
    anyhow::ensure!(world.spend().await? == spent);
    world
        .expect_request(&request_id, "Escalated", false)
        .await?;

    accepted(
        world
            .owner_call("approve_request", json!({ "request_id": request_id }))
            .await?,
    )?;
    world.expect_request(&request_id, "Approved", false).await?;
    anyhow::ensure!(world.spend().await? == spent);
    anyhow::ensure!(amount_field(&world.order(REFUND_APPROVE).await?, "reserved")? == reserved);

    must_fail(
        world
            .owner_call("approve_request", json!({ "request_id": request_id }))
            .await?,
        "E_NOT_ESCALATED",
    )?;
    anyhow::ensure!(world.spend().await? == spent);
    world.expect_request(&request_id, "Approved", false).await?;
    Ok(request_id)
}

async fn reject_request(world: &World, approved_refund_id: &str) -> anyhow::Result<()> {
    world.register(REFUND_REJECT, RECEIVED_LARGE).await?;
    let result = world.refund(REFUND_REJECT, OVER_TX).await?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Escalated", "{status}");
    let spent = world.spend().await?;
    world
        .expect_balances(REFUND_REJECT, OVER_TX, 0, false)
        .await?;

    accepted(
        world
            .owner_call("reject_request", json!({ "request_id": request_id }))
            .await?,
    )?;
    world.expect_request(&request_id, "Rejected", false).await?;
    world.expect_balances(REFUND_REJECT, 0, 0, false).await?;
    anyhow::ensure!(world.spend().await? == spent - OVER_TX);

    let reserved = amount_field(&world.order(REFUND_OK).await?, "reserved")?;
    let spent_after = world.spend().await?;
    must_fail(
        world
            .owner_call(
                "reject_request",
                json!({ "request_id": approved_refund_id }),
            )
            .await?,
        "E_NOT_ESCALATED",
    )?;
    anyhow::ensure!(amount_field(&world.order(REFUND_OK).await?, "reserved")? == reserved);
    anyhow::ensure!(world.spend().await? == spent_after);
    world
        .expect_request(approved_refund_id, "Approved", false)
        .await?;
    Ok(())
}

async fn execute_refund_success_and_failure(
    world: &World,
    approved_refund_id: &str,
) -> anyhow::Result<String> {
    let spent = world.spend().await?;
    let result = execute_refund(world, approved_refund_id, CUSTOMER).await?;
    assert_ft(&result, &world.ft, true)?;
    accepted(result)?;
    world
        .expect_request(approved_refund_id, "Executed", true)
        .await?;
    world.expect_balances(REFUND_OK, 0, SMALL, false).await?;
    anyhow::ensure!(world.spend().await? == spent);

    world.register(REFUND_FAIL, RECEIVED).await?;
    let result = world.refund(REFUND_FAIL, SMALL).await?;
    let (failed_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    let spent = world.spend().await?;
    world.expect_balances(REFUND_FAIL, SMALL, 0, false).await?;

    let result = execute_refund(world, &failed_id, FAIL).await?;
    assert_ft(&result, &world.ft, false)?;
    world.expect_request(&failed_id, "Approved", true).await?;
    world.expect_balances(REFUND_FAIL, 0, 0, false).await?;
    anyhow::ensure!(world.spend().await? == spent - SMALL);
    Ok(failed_id)
}

async fn execute_again(world: &World, executed_id: &str, failed_id: &str) -> anyhow::Result<()> {
    must_fail(
        execute_refund(world, executed_id, CUSTOMER).await?,
        "E_ALREADY_EXECUTED",
    )?;
    must_fail(
        execute_refund(world, failed_id, CUSTOMER).await?,
        "E_ALREADY_EXECUTED",
    )?;
    Ok(())
}

async fn owner_and_escalated_execute(world: &World, escalated_id: &str) -> anyhow::Result<()> {
    world.register(REFUND_OWNER_EXEC, RECEIVED).await?;
    let result = world.refund(REFUND_OWNER_EXEC, SMALL).await?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    must_fail(
        world
            .owner_call(
                "execute_refund",
                json!({
                    "request_id": request_id,
                    "deposit_address": CUSTOMER,
                }),
            )
            .await?,
        "E_NOT_OPERATOR",
    )?;
    world.expect_request(&request_id, "Approved", false).await?;
    world
        .expect_balances(REFUND_OWNER_EXEC, SMALL, 0, false)
        .await?;

    must_fail(
        execute_refund(world, escalated_id, CUSTOMER).await?,
        "E_NOT_APPROVED",
    )?;
    world
        .expect_request(escalated_id, "Escalated", false)
        .await?;
    world.expect_balances(REFUND_ESC, OVER_TX, 0, false).await?;
    Ok(())
}

async fn execute_payouts(world: &World, payout_id: &str) -> anyhow::Result<()> {
    let refs = [
        REFUND_OK,
        REFUND_ESC,
        REFUND_FAIL,
        REFUND_OWNER_EXEC,
        FULFIL_DONE,
    ];
    let before_orders = world.snapshot(&refs).await?;
    let spent = world.spend().await?;
    let result = world
        .operator_call("execute_payout", json!({ "request_id": payout_id }))
        .await?;
    assert_ft(&result, &world.ft, true)?;
    accepted(result)?;
    world.expect_request(payout_id, "Executed", true).await?;
    anyhow::ensure!(world.snapshot(&refs).await? == before_orders);
    anyhow::ensure!(world.spend().await? == spent);

    accepted(
        world
            .owner_call("add_payee", json!({ "payee": FAIL }))
            .await?,
    )?;
    let result = payout(world, FAIL, SMALL, "payout-fail").await?;
    let (failed_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    let spent = world.spend().await?;
    let before_orders = world.snapshot(&refs).await?;
    let result = world
        .operator_call("execute_payout", json!({ "request_id": failed_id }))
        .await?;
    assert_ft(&result, &world.ft, false)?;
    world.expect_request(&failed_id, "Approved", true).await?;
    anyhow::ensure!(world.spend().await? == spent - SMALL);
    anyhow::ensure!(world.snapshot(&refs).await? == before_orders);
    Ok(())
}

async fn pause_and_unpause(world: &World) -> anyhow::Result<()> {
    world.register(REFUND_PAUSE, RECEIVED).await?;
    world.register(REFUND_UNPAUSE, RECEIVED).await?;
    let result = world.refund(REFUND_PAUSE, SMALL).await?;
    let (request_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    let spent = world.spend().await?;

    accepted(world.owner_call("pause", json!({})).await?)?;
    must_fail(world.refund(REFUND_UNPAUSE, SMALL).await?, "E_PAUSED")?;
    world.expect_balances(REFUND_UNPAUSE, 0, 0, false).await?;

    let result = execute_refund(world, &request_id, CUSTOMER).await?;
    assert_ft(&result, &world.ft, true)?;
    accepted(result)?;
    world.expect_request(&request_id, "Executed", true).await?;
    world.expect_balances(REFUND_PAUSE, 0, SMALL, false).await?;
    anyhow::ensure!(world.spend().await? == spent);

    accepted(world.owner_call("unpause", json!({})).await?)?;
    let before = world.spend().await?;
    let result = world.refund(REFUND_UNPAUSE, SMALL).await?;
    let (restored_id, status) = outcome(&json_of(result)?)?;
    anyhow::ensure!(status == "Approved", "{status}");
    world
        .expect_request(&restored_id, "Approved", false)
        .await?;
    world
        .expect_balances(REFUND_UNPAUSE, SMALL, 0, false)
        .await?;
    anyhow::ensure!(world.spend().await? == before + SMALL);
    Ok(())
}

async fn operator_cannot_administer(world: &World) -> anyhow::Result<()> {
    let limits_before = world.view("get_limits", json!({})).await?;
    must_fail(
        world.operator_call("pause", json!({})).await?,
        "E_NOT_OWNER",
    )?;
    must_fail(
        world
            .operator_call(
                "set_caps",
                json!({
                    "per_tx_cap": "1",
                    "daily_cap": "1",
                }),
            )
            .await?,
        "E_NOT_OWNER",
    )?;
    must_fail(
        world
            .operator_call("add_payee", json!({ "payee": "stranger.test.near" }))
            .await?,
        "E_NOT_OWNER",
    )?;
    must_fail(
        world
            .operator_call("remove_payee", json!({ "payee": PAYEE }))
            .await?,
        "E_NOT_OWNER",
    )?;
    anyhow::ensure!(world.view("get_limits", json!({})).await? == limits_before);
    anyhow::ensure!(amount_field(&limits_before, "per_tx")? == PER_TX);
    anyhow::ensure!(amount_field(&limits_before, "daily")? == DAILY);
    Ok(())
}

async fn views(world: &World, order_ref: &str, request_id: &str) -> anyhow::Result<()> {
    let order = world
        .view("get_order", json!({ "order_ref": order_ref }))
        .await?;
    anyhow::ensure!(
        amount_field(&order, "amount_received")? == RECEIVED,
        "{order}"
    );
    anyhow::ensure!(str_field(&order, "refund_destination")? == DEST, "{order}");
    anyhow::ensure!(str_field(&order, "origin_asset")? == ASSET, "{order}");
    anyhow::ensure!(!flag(&order, "fulfilled")?, "{order}");

    let request = world
        .view("get_request", json!({ "request_id": request_id }))
        .await?;
    anyhow::ensure!(
        str_field(&request, "request_id")? == request_id,
        "{request}"
    );
    anyhow::ensure!(str_field(&request, "status")? == "Executed", "{request}");
    anyhow::ensure!(amount_field(&request, "amount")? == SMALL, "{request}");
    anyhow::ensure!(str_field(&request, "order_ref")? == order_ref, "{request}");
    anyhow::ensure!(request["payee"].is_null(), "{request}");
    anyhow::ensure!(request["reference"].is_null(), "{request}");
    anyhow::ensure!(flag(&request, "submitted")?, "{request}");

    let limits = world.view("get_limits", json!({})).await?;
    anyhow::ensure!(amount_field(&limits, "per_tx")? == PER_TX, "{limits}");
    anyhow::ensure!(amount_field(&limits, "daily")? == DAILY, "{limits}");

    let spend = world.view("get_day_spend", json!({})).await?;
    let text = spend
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("day spend {spend}"))?;
    text.parse::<u128>()?;
    Ok(())
}

async fn execute_refund(
    world: &World,
    request_id: &str,
    deposit_address: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    world
        .operator_call(
            "execute_refund",
            json!({
                "request_id": request_id,
                "deposit_address": deposit_address,
            }),
        )
        .await
}

fn accepted(result: ExecutionFinalResult) -> anyhow::Result<()> {
    result
        .into_result()
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("{error} {error:?}"))
}

fn json_of(result: ExecutionFinalResult) -> anyhow::Result<Value> {
    let success = result
        .into_result()
        .map_err(|error| anyhow::anyhow!("{error} {error:?}"))?;
    Ok(success.json()?)
}

fn must_fail(result: ExecutionFinalResult, code: &str) -> anyhow::Result<()> {
    let text = match result.into_result() {
        Ok(success) => anyhow::bail!("{code} succeeded: {success:?}"),
        Err(error) => format!("{error} {error:?}"),
    };
    anyhow::ensure!(
        text.contains(code),
        "expected {code} in the failed transaction: {text}"
    );
    Ok(())
}

fn outcome(value: &Value) -> anyhow::Result<(String, String)> {
    Ok((
        str_field(value, "request_id")?.to_string(),
        str_field(value, "status")?.to_string(),
    ))
}

fn str_field<'a>(value: &'a Value, field: &str) -> anyhow::Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("field {field} in {value}"))
}

fn amount_field(value: &Value, field: &str) -> anyhow::Result<u128> {
    Ok(str_field(value, field)?.parse()?)
}

fn flag(value: &Value, field: &str) -> anyhow::Result<bool> {
    value[field]
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("bool {field} in {value}"))
}

fn assert_no_ft(result: &ExecutionFinalResult, ft: &AccountId) -> anyhow::Result<()> {
    let called = result
        .receipt_outcomes()
        .iter()
        .any(|outcome| &outcome.executor_id == ft);
    anyhow::ensure!(!called, "ft_transfer ran: {result:?}");
    Ok(())
}

fn assert_ft(result: &ExecutionFinalResult, ft: &AccountId, success: bool) -> anyhow::Result<()> {
    let matched = result.receipt_outcomes().iter().any(|outcome| {
        if &outcome.executor_id != ft {
            return false;
        }
        if success {
            outcome.is_success()
        } else {
            outcome.is_failure()
        }
    });
    anyhow::ensure!(matched, "ft receipt success={success} missing: {result:?}");
    Ok(())
}
