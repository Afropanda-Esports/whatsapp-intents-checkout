# Panda Pay Africa — Intents Checkout

> Built at NEAR HACKATHON (1–14 Nov 2026).

Pay for WhatsApp orders with crypto from any chain NEAR Intents supports. Funds settle to USDC on NEAR. Every refund and payout passes an on-chain spending guard.

## Projects

| Project | What it is |
| --- | --- |
| `intents-checkout/` | Payments service: 1Click quotes, status tracking, settlement, signed webhooks, refunds and payouts |
| `checkout-agent/` | Reference WhatsApp agent; holds no keys |
| `checkout-policy/` | NEAR contract: treasury and spending guard (caps, refund-to-origin, supplier allowlist, multisig escalation) |

## Try it (do X → see Y)

1. From the repo root, run `docker compose up`. Wait until the log prints `merchant api key` and `judge-merchant-key`.
2. `GET http://localhost:3000/assets/v1` with header `x-api-key: judge-merchant-key`. The response lists assets. Copy an `assetId`.
3. `POST http://localhost:3000/payments/v1` with the same key and a JSON body: `merchantOrderId` (for example `PPA-1`), `amountOut` as a base-unit string (for example `"1000000"`), `originAsset` set to that `assetId`, and `refundTo` (for example `TJudgeRefundAddress`). The response is a payment and a deposit address.
4. Wait for the status poller, then `GET http://localhost:3000/payments/v1/{paymentId}` with the same key. The payment status is `SETTLED`.
5. `POST http://localhost:3000/payments/v1/{paymentId}/refunds` with the same key and `{ "amount": "1000000", "reason": "customer returned the order" }`. The response is a refund. The webhook sink prints the delivered body.

## NEAR primitive → file map

_TODO_

## Contract addresses

_TODO_
