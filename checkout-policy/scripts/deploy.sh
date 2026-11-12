#!/usr/bin/env bash
# Build the release wasm, print its size, and print the near CLI steps.
# This script never runs near, and it never signs, funds, or deploys.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cargo build --release --target wasm32-unknown-unknown

TARGET_DIR="${CARGO_TARGET_DIR:-${ROOT}/target}"
WASM="${TARGET_DIR}/wasm32-unknown-unknown/release/checkout_policy.wasm"
if [[ ! -f "$WASM" ]]; then
  echo "wasm artifact is missing: ${WASM}" >&2
  exit 1
fi

SIZE="$(wc -c < "$WASM" | tr -d '[:space:]')"
echo "wasm size: ${SIZE} bytes"

MAX_BYTES=1500000
if (( SIZE > MAX_BYTES )); then
  echo "wasm is ${SIZE} bytes, which is above the ${MAX_BYTES} byte limit" >&2
  exit 1
fi

if [[ "${CONFIRM_DEPLOY:-}" != "yes" ]]; then
  echo "CONFIRM_DEPLOY must be exactly yes. Stopped before any network call." >&2
  exit 1
fi

if [[ -z "${CONTRACT_ID:-}" || -z "${OWNER_ID:-}" || -z "${OPERATOR_ID:-}" ]]; then
  echo "CONTRACT_ID, OWNER_ID, and OPERATOR_ID must be set. Stopped before any network call." >&2
  exit 1
fi

NETWORK="${NETWORK:-testnet}"
USDC_TOKEN_ID="${USDC_TOKEN_ID:-USDC_TOKEN_ID}"
PER_TX_CAP="${PER_TX_CAP:-PER_TX_CAP}"
DAILY_CAP="${DAILY_CAP:-DAILY_CAP}"

# Printed for a person to review. No submit step is included.
cat <<EOF
near contract deploy ${CONTRACT_ID} use-file ${WASM} without-init-call network-config ${NETWORK} sign-with-keychain
near contract call-function as-transaction ${CONTRACT_ID} new json-args '{"owner_id":"${OWNER_ID}","operator_id":"${OPERATOR_ID}","usdc_token_id":"${USDC_TOKEN_ID}","per_tx_cap":"${PER_TX_CAP}","daily_cap":"${DAILY_CAP}"}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as ${CONTRACT_ID} network-config ${NETWORK} sign-with-keychain
near account add-key ${OPERATOR_ID} grant-function-call-access --receiver-account-id ${CONTRACT_ID} --method-names register_payment mark_fulfilled request_refund request_payout execute_refund execute_payout autogenerate-new-keypair network-config ${NETWORK} sign-with-keychain
EOF
