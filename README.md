# Panda Pay Africa — Intents Checkout

> Built at NEAR HACKATHON (1–14 Nov 2026).

Pay for WhatsApp orders with crypto from any chain NEAR Intents supports. Funds settle to USDC on NEAR. Every refund and payout passes an on-chain spending guard.

## What it is

WhatsApp crypto checkout that settles USDC on NEAR.

Panda Pay Africa is an existing business. This repository is its NEAR integration, not the naira rail.

## The problem

A merchant cannot take a stablecoin payment on WhatsApp and still cap refunds.

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

| Primitive | Path |
| --- | --- |
| Account and contract | `checkout-policy/src/lib.rs` |
| Money rules | `checkout-policy/src/policy.rs` |
| Cross-contract transfer | `execute_refund` and `execute_payout` in `checkout-policy/src/lib.rs` |
| 1Click quote | `intents-checkout/src/adaptors/one-click/` |
| Agent chat | `checkout-agent/src/domain/conversation/` |

## Contract addresses

Not deployed yet.

## Libraries

Names and version ranges are copied from the manifests. The root `package.json` declares no libraries.

`intents-checkout/package.json` dependencies: drizzle-orm ^0.45.4, fastify ^5.12.8, near-api-js 7.5.3, pg ^8.23.1, pino ^10.4.0, zod ^3.25.76.

`intents-checkout/package.json` devDependencies: @eslint/js ^10.0.1, @types/node ^26.6.6, @types/pg ^8.23.1, drizzle-kit ^0.31.11, eslint ^10.14.0, tsx ^4.23.15, typescript ^6.0.3, typescript-eslint ^8.72.1, vitest ^4.1.12.

`checkout-agent/package.json` dependencies: fastify ^5.12.8, zod ^3.25.76.

`checkout-agent/package.json` devDependencies: @eslint/js ^10.0.1, @types/node ^26.6.6, eslint ^10.14.0, typescript ^6.0.3, typescript-eslint ^8.72.1, vitest ^4.1.12.

`checkout-policy/Cargo.toml` dependencies: near-sdk 5.

`checkout-policy/Cargo.toml` dev-dependencies: near-sdk 5 (feature `unit-testing`), near-workspaces 0.24, tokio 1 (features `macros`, `rt-multi-thread`), anyhow 1, serde_json 1.

## AI-generated code

Parts of this repository were written with AI coding agents and reviewed by a person.
