# Spec 046 — Usage Metering (AI-credit billing, Phase 0)

**Status:** draft · **Branch:** `046-usage-metering` · **Date:** 2026-07-10
**Design survey:** `hrn:node:hadronmemory.com::hadron-server::design:ai-credit-billing`

## Why

Hadron is in pilot with all-free accounts. Headless LLM use (spec 040) makes
that unsustainable; the next phase charges for AI credits with a markup.
Phase 0 is the **processor-agnostic groundwork**: attribute every unit of
platform AI spend to a billable account, price it at event time, and keep an
append-only monetary ledger — WITHOUT charging anyone yet. Payment-processor
integration (MoR vs PSP — Holger's call, undecided) is a later phase.

## What exists / what's missing

Existing: `QuotaCounter` (daily app/org counters, no history), `UsageEvent`
(durable, `model`/`tokensIn`/`tokensOut`, flow-runner only), `AppRun` budgets.
Missing (the four gaps): user/account dimension, money (no price source, no
cost column), a durable monetary ledger, and metering on the embedding path.

## Functional requirements

- **FR-001 Attribution.** Every LLM usage event records the on-behalf-of
  `userId` (nullable — pure-App runs have none) and the `organizationId`
  (the billable unit). MCP usage events record `userId` when the
  authenticated principal is a user.
- **FR-002 Price source.** A `ModelPrice` table keyed `(provider, model,
  effectiveAt)` holds input/output prices in micro-cents per million tokens.
  Rows are operator-managed (platform admin) — env seeds nothing; an unknown
  `(provider, model)` simply yields no cost (never blocks the call).
- **FR-003 Cost-at-write.** Usage events snapshot `costMicroCents` computed
  from the price row effective at event time. Historical costs are never
  recomputed (LLM prices change).
- **FR-004 BYOK.** Events record `keyOwnerType` (`HADRON_SERVER` |
  `ORGANIZATION` | `APP` | `AGENT`) from the resolved AiServiceConfig owner.
  Only `HADRON_SERVER` (platform key) spend is ever debitable; BYOK calls
  still get cost computed for observability but never burn credits.
- **FR-005 Ledger.** `CreditLedgerEntry` is append-only: signed
  `amountMicroCents` (grants +, debits −, adjustments ±), org-scoped,
  `expiresAt` stored as a policy field on grants (enforcement is a later
  phase). Balance = SUM; rows are never mutated or reset.
- **FR-006 Debit gating.** Automatic debits are OFF by default
  (`BILLING_DEBIT_ENABLED`, unset ⇒ off) so the pilot stays free while the
  data flow is real. Debit amount = cost × (1 + `CREDIT_MARKUP_PERCENT`/100),
  default markup 0. A debit failure never fails the run (usage is already
  spent at the provider).
- **FR-007 Embedding metering.** `embedNode` records a usage event
  (`type='embedding'`, estimated `tokensIn`, provider from
  `EMBEDDING_PROVIDER`, org from the memory). Estimation: ceil(chars/4);
  exactness is not required — embedding spend is infra-shaped, the point is
  observability parity.
- **FR-008 Read/admin surface.** Per `cor:api:120` / `cor:api:140`:
  `modelPrice(ref)` + `modelPrices(...)` (authenticated read),
  `setModelPrice` (platform admin), `grantCredits` (platform admin ONLY —
  org admins must not self-grant), `creditLedgerEntries(orgRef, ...)` +
  `creditBalance(orgRef)` (org ADMIN via `requireOrgRole`).

## Non-goals (later phases)

Payment processor, checkout, invoices, credit-expiry FIFO enforcement,
balance-based launch blocking, per-user quotas, chatbot client-side token
metering (client spend is not platform cost), backfilling historical events.

## What invalidates this spec

Choosing a processor whose native credit ledger replaces ours (Polar-style) —
the UsageEvent attribution/cost columns survive that; the ledger might not.
