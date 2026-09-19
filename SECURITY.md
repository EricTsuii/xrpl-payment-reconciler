# Security

## Threat Model

Assets: the correctness of recorded payments (no invented, lost, doubled or mis-sized payment), the integrity of emitted events, and the webhook secret.

In scope: duplicate, replayed or reordered ledger data; endpoints on the wrong network, stale, missing history or answering inconsistently; partial payments that promise more than they deliver; crashes at any step; concurrent reconciliation; webhook receivers that fail or time out; secrets leaking into logs or responses.

Out of scope: a compromised operator, database or host; authentication of API callers; the security of the webhook receiver; a majority of malicious validators.

## No Custody Boundary

The service only reads the ledger and manages subscriptions. It cannot move funds: there is no signing and no submission path.

## No Private Keys

No configuration, table, request or code path holds a seed, private key, mnemonic or secret numbers. A unit test fails the build if `src/` contains wallet construction, seed handling, signing or submission.

## Validated Ledger Boundary

Only validated data becomes a payment. Live messages must say `validated: true`; proposed streams are never subscribed; `account_tx` results reporting `validated: false` stop the reconciliation. Submission results are never observed.

## Partial Payment Safety

Do not trust `Amount` or `DeliverMax` as the received amount. Use `meta.delivered_amount`. The service reads only `delivered_amount`; when it is `"unavailable"` the payment is skipped and logged rather than guessed.

## Financial Amount Precision

Drops are integer strings stored as `NUMERIC(30,0)` and formatted with `BigInt`; issued-currency values are exact strings. No financial value is converted to a floating-point number.

## XRPL Endpoint Trust

Endpoints are trusted only after bootstrap checks, and their data is still checked: required fields and hashes must be present and well formed, transactions must lie within the requested ledger range, the server-reported CTID must match the computed one, and a replayed hash with different data is an integrity error that stops the cursor. A malicious endpoint could withhold data (reconciliation on the other endpoint and readiness make that visible) but cannot make the service record a payment twice.

## Network ID Validation

`server_info.network_id` must equal `XRPL_NETWORK_ID` before an endpoint is used, `ledgerClosed` events are checked continuously, and a transaction whose `NetworkID` field differs is an integrity error. Testnet data can never be recorded by a Mainnet deployment.

## History Coverage

The cursor never moves over a range the endpoint could not fully cover. Missing history triggers a switch to the other endpoint, and if neither covers it the service reports `DEGRADED` instead of skipping.

## Administrative API Exposure

There is no authentication in v0.1.0. The service listens on all interfaces inside its container; compose publishes it on `127.0.0.1` only. Keep it on a trusted network or behind an authenticating proxy. Request bodies are limited to 64 KiB, unknown fields and query keys are rejected, proxy headers are not trusted, and CORS is off.

## Database Credentials

`DATABASE_URL` is read from the environment and never logged or returned; `/v1/status` reports reachability only. The compose credentials are for local development. All SQL goes through Drizzle or bound parameters; raw SQL exists only for `FOR UPDATE SKIP LOCKED` and the conditional cursor update, with every value bound.

## Redis Boundary

Redis stores only per-account leases with a 60-second TTL. Payments, cursors, outbox state, webhook history and the account registry live only in PostgreSQL. Lease refresh and release are owner-checked Lua scripts, so one process can never extend or delete another's lease. `REDIS_URL` is never logged or returned.

## Webhook Secret

`WEBHOOK_SECRET` must be at least 32 UTF-8 bytes and is required together with `WEBHOOK_URL`. It is never logged, stored or returned. The URL must be http or https without embedded credentials.

## HMAC Signature

`X-Reconciler-Signature: sha256=<hex>` is HMAC-SHA256 over the exact stored body with the webhook secret. The body is serialized once, so the event ID, body and signature are identical on every retry. Receivers should verify the signature with a constant-time comparison and deduplicate by `X-Reconciler-Event-Id`. Redirects are not followed.

## Logging

Structured JSON through Nest's `ConsoleLogger`. Logs contain account IDs, addresses, transaction hashes, CTIDs, ledger ranges and endpoint roles — never `DATABASE_URL`, `REDIS_URL`, `WEBHOOK_SECRET`, authorization headers, the environment or raw ledger JSON at `log` level. Error responses carry a code, a message and a request ID, never a stack trace; incoming `X-Request-Id` headers are ignored.

## Raw Ledger Data

`raw_transaction` and `raw_metadata` are stored as received for audit and are returned only by the payment detail endpoint. They are public ledger data.

## Dependency Pinning

Every direct dependency is pinned to an exact version, the lockfile is committed and installed with `--frozen-lockfile`, and Dependabot proposes updates weekly. Container images are pinned by tag; digest pinning lives in a separate supply-chain repository.

## CI Permissions

The workflow runs with `contents: read`, does not persist checkout credentials, uses only `actions/checkout` and `actions/setup-node` pinned by commit SHA, never uses `pull_request_target`, prints no environment on failure, and needs no secrets or external services.

## Known Limitations

- No authentication or authorization.
- One shared webhook secret and URL.
- Endpoint history limits what can be recovered after long outages.
- A malicious endpoint can delay but not falsify recorded payments beyond what the checks above detect.
- Container images are pinned by tag, not digest.

## Vulnerability Reporting

Please report vulnerabilities privately through GitHub's **Report a vulnerability** option on this repository rather than in a public issue, with the affected component and steps to reproduce.
