# Plan 046 — Usage Metering (Phase 0)

## Data model (additive migration `20260710210000_usage_metering`)

**UsageEvent** (extend):
- `userId String?` → FK `users` SetNull, indexed — on-behalf-of user.
- `organizationId String?` → FK `organizations` SetNull, indexed — billable unit.
- `provider String?` — model names collide across providers.
- `keyOwnerType String?` — AiConfigOwnerType of the key that served the call.
- `costMicroCents BigInt?` — snapshot at write; null = no price known / n/a.

**ModelPrice** (new, `model_prices`): `id`, `provider`, `model`,
`inputMicroCentsPerMTok BigInt`, `outputMicroCentsPerMTok BigInt`,
`effectiveAt`, audit cols. Unique `(provider, model, effectiveAt)`.
Lookup: latest `effectiveAt <= at`. String columns, no enums (avoids the
enum-add/CHECK two-migration rule); validation in code like QuotaCounter.

**CreditLedgerEntry** (new, `credit_ledger_entries`): `id`,
`organizationId` (FK Cascade, required), `kind` (`grant|debit|adjustment`),
`amountMicroCents BigInt` (signed), `expiresAt?`, `sourceType?`/`sourceId?`
(e.g. `usage-event`/id), `note?`, `createdAt`/`createdBy`.
Index `(organizationId, createdAt)`. Append-only by convention — no update
surface anywhere.

## Modules

- `src/lib/metering/index.ts` — price lookup (60s TTL cache keyed
  provider:model), `computeCostMicroCents` (BigInt math, ceil), 
  `recordLlmUsage` (single write path for token-bearing usage events; calls
  `maybeDebit`), `grantCredits`, `debitCredits`, `creditBalance`
  (`aggregate _sum`). Debits: `BILLING_DEBIT_ENABLED` + markup env read at
  call time (test-friendly), only for `keyOwnerType === 'HADRON_SERVER'`,
  `.catch(() => {})` posture mirrors the existing usage-event write.

## Wire-in

1. `src/jobs/appRuns.ts` hop write (~:781) → `recordLlmUsage` with
   `run.userId`, `run.organizationId`, `resolved` (in scope at :732).
2. `src/jobs/embedNodes.ts` `embedNode` → one `type='embedding'` event after
   successful embed (abstract + chunks summed).
3. `src/mcp/server.ts` four usage-event creates: add `userId` from auth when
   the principal is a user (keep `createdBy` semantics untouched).
4. `createUsageEvent` controller op: pass through new optional fields.

## GraphQL

Types `ModelPrice`, `CreditLedgerEntry`, `CreditBalance { organizationId,
balanceMicroCents }`; extend `UsageEvent`. Queries `modelPrice(ref)`,
`modelPrices(provider, model, limit, offset) → {items,total}`,
`creditLedgerEntries(orgRef, limit, offset) → {items,total}`,
`creditBalance(orgRef)`. Mutations `setModelPrice(input)` /
`grantCredits(input)` — platform-admin gate (same as other host-level ops);
org read surface via `requireOrgRole(ADMIN)`. BigInt travels as String in
GraphQL (custom scalars out of scope — serialize `.toString()`).

## Testing

- `metering.test.ts` unit: price effective-dating, cache, cost math incl.
  rounding, markup, debit gating matrix (flag × keyOwnerType).
- integration: app-run hop event enrichment; embedding event; ledger
  grant/balance/list + org-admin vs non-member vs platform-admin auth.

## Risks / notes

- `hops` JSON + `budgetTokens` decrement untouched — kill-switch semantics
  unchanged.
- BigInt in Prisma → JS bigint; GraphQL layer must stringify.
- CLI parity: new surface needs hadron-cli coverage — parity issue filed at
  implementation end (hadron-cli#134 umbrella).
