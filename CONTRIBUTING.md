# Contributing

## Scope

v0.1.0 is feature-complete. New transaction or asset types, infrastructure, brokers, storage systems, authentication or deployment tooling are out of scope without a new approved specification. Bug fixes, tests and documentation corrections are welcome.

## Setup

```bash
bash scripts/doctor.sh
pnpm install --frozen-lockfile
docker compose up -d postgres redis
bash scripts/wait-for-services.sh
pnpm db:migrate
```

## Before a pull request

```bash
pnpm check
pnpm test:integration
pnpm test:e2e
```

## Rules

- Direct dependencies stay pinned to exact versions, without `^` or `~`.
- No wallet, seed, signing or submission code anywhere.
- No automated test may depend on a public XRPL network; use `FakeLedgerClient` and fixtures shaped like real API v2 responses.
- Live and reconciliation paths share `PaymentNormalizer`; never add path-specific business rules.
- Financial values stay strings or `BigInt`; never JavaScript `number`.
- Schema changes go through `pnpm db:generate` and a committed migration; never `drizzle-kit push`.
