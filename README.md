# XRPL Payment Reconciler

## Description

> **XRPL Payment Reconciler is a backend reference service that tracks configured XRP Ledger accounts, persists successful validated incoming payments and produces durable application events.**

> **WebSocket subscriptions provide low-latency ingestion, while periodic account history reconciliation provides the correctness path for recovering missed transactions after disconnects, failover or event replay.**

## Why

Listening to an XRPL WebSocket is easy; trusting it is not. Connections drop, endpoints fail over, messages arrive twice, and a process restarts halfway through writing a payment. An application that credits users from the stream alone either misses payments or credits them twice.

This service treats the stream as a latency optimization and the account history as the source of correctness. Every path funnels into one normalizer and idempotent storage, and every stored payment produces exactly one durable event for downstream systems.

## Core Guarantees

> **A validated payment may be observed more than once, but it must be recorded only once.**

> **A WebSocket connection is treated as a latency optimization, not a guarantee that no ledger activity was missed.**

- Only successful payments in validated ledgers are recorded; proposed transactions and submit results never are.
- The received amount is always `meta.delivered_amount`, never `Amount` or `DeliverMax`.
- One XRPL payment → one payment row → one outbox event, no matter how often it is seen.
- A reconciliation cursor moves only after its whole ledger range was inspected.
- No wallet, no keys, no signing, no submission.

## Architecture

```text
            Primary xrpld ── or ── Secondary xrpld      (one active client)
                         │
          ┌──────────────┴──────────────┐
   live account subscription       account_tx by cursor
      (low latency)                 (correctness path)
          └──────────────┬──────────────┘
              ValidatedTransactionEnvelope
                         │
                  PaymentNormalizer
                         │
        PostgreSQL: payments + outbox_events (one transaction)
                         │
            OutboxWorker → HMAC-signed webhook (at least once)

   Redis: per-account reconciliation lease only
```

NestJS 12 on Fastify, PostgreSQL 17 through Drizzle ORM, Redis 7 for leases, `xrpl.js` 5 as a read-only client. See [ARCHITECTURE.md](ARCHITECTURE.md).

## How Correctness Works

1. **Cursor.** Each monitored account has `last_reconciled_ledger = N`: its history through validated ledger N has been inspected.
2. **Reconciliation.** Under the account's Redis lease, `account_tx` is read from N+1 to the current validated ledger, fixed for the run, through every marker page.
3. **Coverage.** The server must cover the whole range; otherwise the service switches endpoints and scans again.
4. **Storage.** Each transaction goes through the single normalizer; accepted payments are inserted with their outbox event in one PostgreSQL transaction. Unique constraints on the transaction hash and on the CTID absorb replays.
5. **Advance.** Only when all pages are processed, no integrity error occurred and the lease is still held does the cursor move — with an optimistic update that fails if anyone else moved it.

A crash anywhere before step 5 simply replays the range; the unique constraints make the replay harmless.

## Live vs Reconciliation Path

| | Live subscription | Reconciliation |
|---|---|---|
| Trigger | validated `accounts` stream message | startup, activation, reconnect, failover, every 30 s |
| Latency | seconds | up to one interval |
| Guarantee | none — may miss or repeat | complete for the range |
| Moves the cursor | never | yes, after a full range |
| Normalization | `PaymentNormalizer` | the same `PaymentNormalizer` |

A payment seen live and again through `account_tx` is stored once.

## Supported Payment Semantics

- `TransactionType = Payment`, `Destination` = an enabled monitored account, `validated = true`, `meta.TransactionResult = tesSUCCESS`.
- **Assets:** XRP (drops) and issued currencies. MPT and unknown shapes are logged and skipped (`UNSUPPORTED_ASSET_TYPE`); `delivered_amount = "unavailable"` is skipped (`UNSUPPORTED_DELIVERED_AMOUNT`).
- **Delivered amount:** Do not trust `Amount` or `DeliverMax` as the received amount. Use `meta.delivered_amount`. A partial payment stores what actually arrived.
- **Precision:** drops are integer strings stored as `NUMERIC(30,0)`; issued values are stored as the exact strings the ledger returned. No JavaScript floating point touches a financial value; XRP is formatted from drops with `BigInt` arithmetic.
- **Ignored:** outgoing payments, self-payments, failed (`tec*`) payments and non-payments. They never block the cursor.
- **CTID:** every payment gets a Concise Transaction Identifier computed from ledger index, transaction index and network ID, checked against the CTID the server reports.
- **DestinationTag:** stored and filterable when present.

## Stack

| Component | Version |
|---|---|
| Node.js | 22.23.2 |
| pnpm | 12.4.1 |
| NestJS + Fastify | 12.0.2 + 5.12.4 |
| PostgreSQL | 17.11 |
| Redis | 7.4.11 |
| Drizzle ORM | 0.45.2 |
| xrpl.js | 5.2.0 |
| TypeScript | 5.9.3 (strict) |

All direct dependencies are pinned to exact versions.

## Quick Start

Host app:

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres redis
pnpm db:migrate
pnpm start:dev
```

Full Docker:

```bash
docker compose up --build
```

Both run against the public XRPL Testnet and publish ports on `127.0.0.1` only. `bash scripts/doctor.sh` checks the toolchain.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `DATABASE_URL` | yes | |
| `REDIS_URL` | yes | |
| `XRPL_PRIMARY_URL` / `XRPL_SECONDARY_URL` | yes | Testnet in `.env.example` |
| `XRPL_NETWORK_ID` | no | `1` (0–65535) |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | together, or neither | delivery disabled |
| `LOG_LEVEL` | no | `log` (`error`, `warn`, `log`, `debug`) |
| `PORT` | no | `3000` |

The webhook secret must be at least 32 UTF-8 bytes. Without webhook configuration events are still created and stay `PENDING`. Every other tuning value is a fixed constant.

## Add a Monitored Account

```bash
curl -s -X POST http://127.0.0.1:3000/v1/accounts \
  -H 'Content-Type: application/json' \
  -d '{"address":"r...","label":"Treasury"}'
```

The account must exist in a validated ledger. Monitoring starts at the current validated ledger H0: the service subscribes, captures H1, reconciles H0+1…H1 and only then enables the account, so a payment that lands during activation is never lost. Up to 25 accounts can be enabled.

`DELETE /v1/accounts/:id` disables monitoring: it unsubscribes, captures Hstop, reconciles up to it, and then disables — the tail is never dropped. Posting a disabled address again reactivates it from a new H0.

## Inspect Payments

```bash
curl -s 'http://127.0.0.1:3000/v1/payments?limit=10'
curl -s 'http://127.0.0.1:3000/v1/payments?destinationTag=123&assetType=XRP'
curl -s http://127.0.0.1:3000/v1/payments/by-hash/<hash>
curl -s http://127.0.0.1:3000/v1/payments/<id>          # includes rawTransaction/rawMetadata
```

Lists are ordered by ledger index, transaction index and id, newest first, with a keyset `cursor`.

## Webhook Delivery

> **Webhook delivery is at-least-once. The event ID is stable across retries and consumers should deduplicate by `X-Reconciler-Event-Id`.**

Each accepted payment creates one `payment.validated` event whose body is serialized once. Requests carry:

```text
Content-Type: application/json
User-Agent: xrpl-payment-reconciler/0.1.0
X-Reconciler-Event-Id: <event id>
X-Reconciler-Signature: sha256=<HMAC-SHA256 of the exact body, lowercase hex>
```

2xx is success. Failures (network error, 5-second timeout, any other status including redirects) retry after 1, 5, 15 and 30 seconds; the fifth failure marks the event `DEAD`. A worker holds an event for 15 seconds; if it dies, the lock expires and another attempt may follow — which the stable event ID makes safe. DEAD events stay visible in `/v1/status` and never affect readiness.

## Failure Recovery Scenarios

Each is an automated test:

| Scenario | Behaviour |
|---|---|
| Duplicate replay | the same transaction five times → 1 payment, 1 event |
| Live/backfill overlap | seen live, then in `account_tx` → stored once |
| Registration race | payment between H0 and H1 → recovered by activation reconciliation |
| Primary endpoint loss | failover to the secondary; the missed payment recovered by `account_tx` |
| History-gap failover | primary lacks the range → sequential switch to the secondary |
| Both endpoints lack history | cursor unchanged, reconciliation `DEGRADED`, `/readyz` 503 |
| Cursor crash replay | payments stored, crash before the cursor update → replay with no duplicates |
| Partial payment | stores `delivered_amount`, not `DeliverMax` |
| Webhook retry | 500, 500, 204 → delivered on attempt 3 with the same body and signature |
| DEAD delivery | five failures → `DEAD`; payment kept, service still ready |

## REST API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | process liveness |
| `GET` | `/readyz` | PostgreSQL, Redis, XRPL, subscriptions, reconciliation |
| `POST` | `/v1/accounts` | start monitoring (201 new, 200 reactivated) |
| `GET` | `/v1/accounts` | all monitored accounts with cursors |
| `DELETE` | `/v1/accounts/:id` | stop monitoring (204) |
| `GET` | `/v1/payments` | list: `accountId`, `destinationTag`, `assetType`, `limit` ≤ 100, `cursor` |
| `GET` | `/v1/payments/by-hash/:hash` | one payment by transaction hash |
| `GET` | `/v1/payments/:id` | one payment with raw ledger data |
| `GET` | `/v1/status` | connection, reconciliation and outbox counters |

Responses under `/v1` use `{ "data": ... }`; errors use `{ "error": { "code", "message", "requestId" } }` without stack traces. Every response carries a fresh `X-Request-Id`.

> **Administrative REST endpoints are intended for a trusted private/local network boundary and must not be exposed directly to the public Internet without an external authentication layer.**

## Database Model

A committed Drizzle SQL migration creates:

- `monitored_accounts` — address, label, enabled; unique per network.
- `account_cursors` — last reconciled ledger per account, cascading with it.
- `payments` — normalized payment plus raw transaction and metadata; unique `(network_id, transaction_hash)` and `(network_id, ctid)`; check constraints on hashes, CTID format, ranges and the asset columns.
- `outbox_events` — one `payment.validated` event per payment, `PENDING`/`DELIVERED`/`DEAD`, lock and attempt columns.

PostgreSQL reserves `ctid` as a system column name, so the column is called `xrpl_ctid`; the API and webhooks still call the field `ctid`.

## Testing

```bash
pnpm check              # format, lint, typecheck, unit tests, build
pnpm test:integration   # real PostgreSQL 17.11 and Redis 7.4.11
pnpm test:e2e           # full application against PostgreSQL, Redis and FakeLedgerClient
pnpm test:testnet       # optional read-only smoke test against the public Testnet
```

Integration and E2E tests need `docker compose up -d postgres redis` and `pnpm db:migrate`. XRPL behaviour comes from `FakeLedgerClient` and fixtures shaped after real `rippled` 3.4.0 API v2 responses; no automated test reaches a public network.

## CI

GitHub Actions on `ubuntu-24.04` with `contents: read`:

- **quality** — install with the frozen lockfile and run `pnpm check`.
- **integration** — PostgreSQL and Redis through compose, migrations, integration and E2E tests, image build, safe diagnostics on failure, `docker compose down -v` always.

Only `actions/checkout` and `actions/setup-node`, pinned by commit SHA. No secrets, no public XRPL server, no cost.

## Security Boundary

The repository contains no wallet, seed, private key, mnemonic, signing, transaction submission or custody logic; a unit test scans `src/` to keep it that way. See [SECURITY.md](SECURITY.md).

## Operational Limitations

- One network per deployment; at most 25 enabled accounts; one XRPL connection with no automatic failback.
- Reconciliation needs an endpoint whose history covers the gap since the cursor; after a long outage that may require a full-history server.
- Reactivation does not backfill the period an account was disabled.
- Webhook delivery is sequential, one event at a time.
- No authentication: keep the API on a trusted network.

## What This Is / Is Not

**Is:** a reference backend for turning validated incoming XRPL payments into durable, idempotent application events with gap recovery.

**Is not:** a payment processor, a custody platform, a banking backend, a complete XRPL indexer or wallet infrastructure. It never sends a transaction.

## Repository Structure

```text
src/
  config/          environment validation
  common/          constants, error contract, request ids
  database/        Drizzle schema and migration runner
  redis/           connection and per-account leases
  health/          liveness, readiness, status, lifecycle
  accounts/        monitored accounts API and persistence
  xrpl/            the only XRPL client, failover, subscriptions, normalizer, CTID, amounts
  reconciliation/  live ingestion, account_tx reconciliation, scheduling
  payments/        payments API and idempotent storage
  outbox/          transactional outbox and worker
  webhooks/        HMAC signing and HTTP delivery
drizzle/           committed SQL migration
test/              unit, integration, E2E, FakeLedgerClient, fixtures, webhook sink, Testnet smoke
scripts/           doctor.sh, wait-for-services.sh
```

## Upstream References

- [Monitor Incoming Payments with WebSocket](https://xrpl.org/docs/tutorials/http-websocket-apis/build-apps/monitor-incoming-payments-with-websocket)
- [Look Up Transaction Results](https://xrpl.org/docs/concepts/transactions/finality-of-results/look-up-transaction-results)
- [Partial Payments](https://xrpl.org/docs/concepts/payment-types/partial-payments)
- [account_tx](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_tx)
- [subscribe](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/subscription-methods/subscribe)
- [CTID (XLS-37)](https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0037-concise-transaction-identifier-ctid)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The scope of v0.1.0 is fixed.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
