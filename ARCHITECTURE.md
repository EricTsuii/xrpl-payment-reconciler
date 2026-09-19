# Architecture

## Purpose

Turn successful, validated incoming XRP Ledger payments to a small set of monitored accounts into durable payment records and exactly one durable application event each — even when the WebSocket drops, endpoints fail over, transactions are observed repeatedly or the process restarts mid-write.

## System Boundary

Inside: the REST API, PostgreSQL state, Redis leases, one XRPL WebSocket connection, the reconciliation scheduler, and the outbox worker that calls one configured webhook.

Outside: anything that signs or submits transactions (nothing here does), caller authentication, the webhook receiver's deduplication, and XRPL history beyond what the configured endpoints hold.

## Core Invariants

1. One successful validated XRPL Payment creates exactly one payment record and exactly one outbox event, however often it is ingested, replayed or recovered.
2. Only validated ledger data becomes a payment.
3. The received amount is `meta.delivered_amount`.
4. Live WebSocket processing never changes a reconciliation cursor.
5. A cursor moves only after complete, integrity-checked reconciliation of its range while the account lease is held.
6. A payment and its outbox event commit together or not at all.
7. At most one XRPL client is connected at a time.

## Ledger vs Application Truth

The validated XRP Ledger is the truth about what happened. PostgreSQL is the truth about what this application has recorded and emitted. Redis holds only short-lived leases and can be flushed at any time without losing anything. The WebSocket is neither: it is a hint that something probably happened.

## Connection Manager

`ConnectionManagerService` owns the single active `LedgerClient`. Bootstrap, in order: connect, `server_info`, validate network ID, server state, validated ledger and its age, subscribe to the `ledger` stream, subscribe all enabled accounts. Only then is the endpoint active and every bootstrap listener notified.

A request that fails in transport, or returns an unreadable response, causes one sequential failover: the old client's listeners are removed and it is disconnected before the alternate is created, bootstrapped and asked again. Concurrent failures share one switch. Server errors (`lgrIdxMalformed`, `actNotFound`) are answers, not failures. After a failover the service stays on the alternate endpoint; when both are unusable it drops the connection and reconnects in the background after 1, 2, 5, 10 and then every 30 seconds. An XRPL outage never ends the process.

Only `src/xrpl/` creates `xrpl.Client`; everything else uses the manager.

## Endpoint Validation

An endpoint is refused unless `server_info.info.network_id` equals `XRPL_NETWORK_ID`, `server_state` is `tracking`, `full`, `validating` or `proposing`, a validated ledger exists and its age is under 20 seconds. A `ledgerClosed` event with a different `network_id` later disconnects the endpoint and fails over.

## Live Ingestion

The `accounts` subscription delivers validated transactions affecting monitored accounts; proposed streams are never subscribed. `LiveIngestionService` processes messages one at a time: `validated` must be `true`, the destination must be an enabled monitored account, and the message goes through the same envelope, normalizer and storage as reconciliation. It never touches a cursor, and it may miss or repeat events without consequence.

## Reconciliation Correctness Path

`ReconciliationService.runCycle` is single-flight and coalescing: at most one cycle runs; a trigger during a run schedules one more. Triggers: startup, account activation, every endpoint bootstrap (reconnect, failover) and every 30 seconds. Accounts are processed sequentially, each under its Redis lease; an account whose lease another owner holds is skipped for the cycle.

For each account: the range is `cursor + 1 … target`, with `target` the validated ledger read at the start and fixed for the run (an empty range succeeds immediately). `account_tx` is called with `api_version: 2`, `forward: true`, `limit: 200`, and continued with each opaque `marker` exactly as returned until no marker remains. Each page must cover the requested range (`ledger_index_min ≤ from`, `ledger_index_max ≥ to`), must not say `validated: false` (an absent flag is allowed), and every transaction must lie inside the range.

If the endpoint lacks the history — a narrower reported range or a history error (rippled 3.x answers `lgrIdxMalformed` for a start below its history; the service never asks beyond the endpoint's validated ledger, so the answer is unambiguous) — the manager switches to the other endpoint and the whole range is scanned again. If neither covers it, the cursor stays, the reconciliation status becomes `DEGRADED` and readiness fails. A cycle's own history switch does not trigger another cycle, so two endpoints that both lack the history cannot bounce the connection back and forth.

If a transport failover happens mid-pagination the scan stops without moving the cursor: markers belong to the endpoint that issued them. No database transaction is open during XRPL I/O; each transaction is stored in its own short transaction.

## Cursor Semantics

`last_reconciled_ledger = N` means the account's history through validated ledger N has been inspected by the reconciliation path. The cursor moves only after every page is processed, coverage is confirmed, no integrity error occurred and the lease is confirmed still owned — and then with an optimistic `UPDATE … WHERE last_reconciled_ledger = <expected>` that must affect exactly one row. A crash after storing payments but before this update replays the range; unique constraints absorb the replay.

## Account Activation Race Closure

Activation: capture validated ledger H0 → insert the account disabled with cursor H0 → acquire the lease → subscribe → capture H1 → reconcile H0+1…H1 → enable (checking the 25-account limit atomically) → release. A payment validated while the subscription was being made lands between H0 and H1 and is found by the activation reconciliation. Live events for the still-disabled account are ignored, which is safe: later cycles start from H1. If any step fails the service unsubscribes, deletes the new account (its cursor cascades) and answers `503 ACCOUNT_ACTIVATION_FAILED`; if the activation reconciliation had already stored a payment, the account row is kept disabled because payments reference it.

Reactivation of a disabled account resets its cursor to a new H0: the disabled period is not backfilled.

## Account Disable Boundary

Disable: acquire the lease → unsubscribe and wait for the confirmation → capture Hstop → reconcile cursor+1…Hstop → disable → release → 204. Capturing Hstop after the unsubscribe confirmation means nothing that could still arrive live is left unreconciled. On failure the account is re-subscribed (best effort), stays enabled, and the call answers `503 ACCOUNT_DISABLE_FAILED`.

## Payment Normalization

`PaymentNormalizerService` is the only business normalization. Its outcomes:

| Outcome | When | Cursor |
|---|---|---|
| `ACCEPTED` | incoming, successful, supported amount | moves |
| `DUPLICATE` | same hash, identical data (from storage) | moves |
| `IGNORED_NON_PAYMENT` | not a Payment | moves |
| `IGNORED_OUTGOING_PAYMENT` | monitored account is not the destination | moves |
| `IGNORED_SELF_PAYMENT` | Account equals Destination | moves |
| `IGNORED_FAILED_TRANSACTION` | validated with a non-`tesSUCCESS` result | moves |
| `UNSUPPORTED_DELIVERED_AMOUNT` | `delivered_amount = "unavailable"` | moves |
| `UNSUPPORTED_ASSET_TYPE` | MPT or unknown amount shape | moves |
| `INTEGRITY_ERROR` | malformed validated data, contradicting CTID, conflicting duplicate | stays |

The envelope (`source`, network ID, ledger index and hash, close time, transaction hash, `tx`, `meta`) is built identically from stream messages and `account_tx` entries; close time comes from `close_time_iso`, falling back to `tx_json.date` converted from the Ripple epoch.

## Financial Amount Handling

The received amount is `meta.delivered_amount`: `Amount` and `DeliverMax` state a maximum, and for a partial payment far less may arrive. XRP arrives as a drops string, is validated as a positive integer, canonicalized with `BigInt` and stored as `NUMERIC(30,0)`; `formatDropsToXrp` renders XRP with integer arithmetic only. Issued-currency currency, issuer and value are stored as the exact strings the ledger returned. No financial value ever becomes a JavaScript `number`.

## CTID

Each payment's CTID is `((0xC0000000 + ledgerIndex) << 32) + (transactionIndex << 16) + networkId` as 16 uppercase hex characters, with bounds 0–268,435,455, 0–65,535 and 0–65,535. When the server reports a CTID (stream messages at the top level, `account_tx` inside `tx_json`) it must match; the formula agrees with `rippled` 3.4.0 on the public Testnet. The database column is `xrpl_ctid` because PostgreSQL reserves `ctid` as a system column name.

## Idempotency

`payments` is unique on `(network_id, transaction_hash)` and `(network_id, xrpl_ctid)`; `outbox_events` is unique on `(event_type, aggregate_id)`. An insert that conflicts on the hash loads the stored row and compares the critical fields (CTID, ledger index and hash, transaction index, source, destination, tag, asset and amount, result): identical is `DUPLICATE`, different is `INTEGRITY_ERROR`. A new hash that collides on the CTID rolls back as `INTEGRITY_ERROR`. Nothing is ever silently ignored.

## Transactional Outbox

A new payment and its `payment.validated` event are inserted in one PostgreSQL transaction; if the event insert fails, the payment rolls back. The webhook body is serialized once, at that moment, and stored in `outbox_events.body`; retries never re-serialize it.

## Webhook Delivery

The worker polls every 500 ms and claims one event at a time: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over pending, due, unlocked events with attempts left, then — in the same transaction — `locked_by = <instance id>`, `locked_until = now() + 15 s`, `attempt_count + 1`, committed before the HTTP request. Every later update requires `locked_by` to still be this instance. A 2xx response marks the event `DELIVERED`; a failure schedules the next attempt after 1, 5, 15 or 30 seconds, and the fifth marks it `DEAD`. Redirects are failures, so a signed body goes only to the configured URL. A worker that dies leaves a lock that expires after 15 seconds; another attempt may follow. An event whose fifth attempt was interrupted that way becomes `DEAD` instead of breaching the five-attempt limit.

Without webhook configuration events are still created and stay `PENDING`.

## Redis Lease

Key `xrpl-reconciler:reconcile:<networkId>:<accountId>`. Acquire with `SET key <uuid> NX PX 60000`; refresh every 20 seconds and right before the cursor update with a Lua script that extends the TTL only if the value is still this token; release with a Lua script that deletes only this token. A failed refresh marks the lease lost; the reconciliation stops before its cursor update. Activation and disable use the same lease, so a periodic cycle never reconciles an account they are working on. Redis holds nothing else.

## Failure Recovery

| Failure | Recovery |
|---|---|
| Duplicate or replayed transaction | unique constraints; DUPLICATE |
| Disconnect | failover, resubscription, reconciliation of the gap |
| Endpoint without history | sequential switch; DEGRADED if neither has it |
| Crash before cursor update | range replayed idempotently |
| Crash after outbox claim | lock expires, event claimed again |
| Webhook receiver down | retries, then DEAD; payment kept |
| XRPL down at startup | process up, not ready, reconnecting |
| PostgreSQL or Redis down at startup | process exits non-zero after 10 seconds |

Shutdown runs in a fixed order within a 10-second deadline: readiness false → stop the scheduler (waiting for the running cycle) → stop the outbox worker (waiting for the delivery in flight) → drain live ingestion → disconnect XRPL → close Redis → end the PostgreSQL pool.

## Readiness

`/readyz` is 200 only when PostgreSQL and Redis answer, an XRPL endpoint is active (network validated, ledger and account subscriptions made), a full reconciliation cycle has completed since that endpoint came up, and the reconciliation status is `HEALTHY`. With no enabled accounts, a cycle completes right after bootstrap. DEAD webhook events and disabled delivery do not affect readiness. `/healthz` reports liveness only.

## Testing Strategy

- **Unit** — CTID vectors (including ones observed on the Testnet), XRP formatting, delivered-amount parsing, every normalizer outcome, envelopes, HMAC, the lease object, configuration, endpoint validation and failover, and a scan of `src/` for wallet or signing code.
- **Integration** (PostgreSQL 17.11, Redis 7.4.11) — five-fold and concurrent idempotency, conflicting duplicates, CTID collision, outbox atomicity, cursor monotonicity, lease ownership and outbox claims.
- **E2E** (full application, `FakeLedgerClient`) — live/backfill overlap, disconnect recovery, registration race, pagination, optional and false `validated`, history failover, both endpoints insufficient, cursor crash, lease loss, disable boundary, restart catch-up, webhook retry, DEAD events and lock reclaim, and the REST contract.

`FakeLedgerClient` answers from fixtures shaped after real `rippled` 3.4.0 API v2 responses; nothing in CI contacts a public network. NestJS 12 and the noble/scure cryptography libraries used by `xrpl.js` are ES modules only; Node.js 22 loads them from CommonJS, and `test/esm-to-cjs.transform.cjs` does the same for Jest 29.

## Non-Goals

Wallet custody, wallet generation, seed management, signing, transaction submission and outbound payments; X-addresses; NFT, DEX, AMM, Lending Protocol, MPT business support, escrow and payment channels; a full historical indexer or an arbitrary backfill API; a Clio requirement or `xrpld` deployment; Kafka, RabbitMQ or NATS; MinIO or S3; Elasticsearch or OpenSearch; GraphQL, gRPC or generated OpenAPI; authentication, authorization and multi-tenancy; Prometheus, Grafana or OpenTelemetry; Kubernetes, Helm, Terraform or cloud deployment.
