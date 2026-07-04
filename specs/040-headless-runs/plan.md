# Implementation Plan — Headless Agent Runs (trigger → NATS → authorized LLM execution)

**Feature**: Work is triggered without a human present — a schedule fires, a webhook
arrives, an integration receives a message — a `run.requested.v1` message lands on the
platform bus, and a listener executes an agent run: authorized against the platform
permission model, budgeted, LLM-driven, fully recorded. First concrete use case: the
morning briefing ("prepare my briefing while I get coffee").

**Date**: 2026-07-04 · **Status**: Plan of record for the 3-day Fable window; Days 2–3
build the kernel + first triggers, everything else is the Opus handoff (§10).

---

## 1. Grounding — this plan implements decided design, it does not re-decide it

| Source | What it dictates here |
|---|---|
| D-2026-05-09-001..025 (headless runner) | Vercel AI SDK (D1); `AppRun` entity (D11); prompts are Nodes (D12); tools per node + platform always-on set (D14); event entry points are Nodes (D17); `spawn` fan-out (D18/D19, post-v1); FAILED-run observability incl. entry-lookup failures (D20); tool errors terminate v1 runs (D21); 4-section system prompt (D22, post-v1 composition); timeouts (D24). |
| D-2026-05-02-001..007 (webhooks) | `AgentWebhook` table; opaque-secret URL + platform JWT (two factors); GET + POST with 202 + optional callback; per-webhook AI-config override. |
| D-2026-06-19-001..006 (authorization) | Allow-only declarative rules, default-deny (cor:acl:040); conjunctive chain org → user → app → run — every layer only restricts; platform authorizes first (floor); two-tier quotas as the **headless launch gate** (cor:acl:050); activation minted post-authz with live-budget kill switch; tools are action-vocabulary entries; RBAC is sugar. |
| D-2026-06-11 / D-2026-06-17 (bus + tools) | NATS JetStream jobs idiom (built: `src/lib/bus/`, #462 #489); at-least-once + idempotent claim; subjects versioned dot-delimited; NATS internal-only — third parties enter over HTTP. |
| **D-2026-07-04-A..F (v1 cuts, Holger)** | See §2 — the scope decisions this plan encodes. Durable record: `hadronmemory.com::hadron-server::decisions:2026-07-04-headless-v1-cuts`. |
| Built substrate (verified 2026-07-04) | Auth principals (`AuthContext`), six-class memory gates (owner-only personal/private — no App/ADMIN bypass), `runTask` instruction assembly (template + dependency inlining, NO LLM call today), spec-036 `AiServiceConfig` walk (no consumer yet — `src/lib/llm` is net-new), `UsageEvent`, the #489 listener idiom. |

## 2. The v1 cuts (D-2026-07-04, binding)

- **A — rule-engine SHAPE, not language**: action vocabulary + `evaluatePolicyChain()`
  (strict conjunction) + minimal JSON allow-list rules carried on trigger/run rows,
  layered over the existing gates. No Rule table, no authoring UI in v1.
- **B — quota cut**: counters for `run.execute` (runs/day) and `llm.tokens` (tokens/day),
  per App AND per org. Tickets for ONE action class: outbound communication. Both tiers
  ship (the cor:acl:050 launch gate is met honestly); briefings consume zero tickets.
- **C — principal**: `appId` required + optional on-behalf-of `userId` captured at
  trigger creation; authority = conjunction(App, user-when-present). Amends D23
  (service-identity becomes the no-user degenerate case). Team-wide personal reads are
  post-v1: spawn fan-out or MemoryShare grants — never an App-only rule.
- **D — activation = the AppRun row**: created after the launch-gate check; carries the
  policy snapshot + live budgets + status. Every action re-checks the row. No exported
  bearer credential ⇒ PoP/key custody deferred (Q-2026-06-19-002) until tokens cross a
  process boundary.
- **E — per-kind triggers**: `AgentSchedule` (new, mirrors the decided `AgentWebhook`
  shape). No generic trigger table.
- **F — kernel = single-entry-node runs**: runTask assembly → one LLM completion →
  writes via `writeNodeCore` under the captured principal → `AppRun` + `UsageEvent` +
  budget decrement. Edge-walking / spawn / schema envelopes / 4-section prompt → §10.

## 3. Data model (Prisma sketch)

```prisma
enum AppRunStatus { PENDING RUNNING COMPLETED FAILED TIMED_OUT CANCELLED }

model AppRun {
  id             String       @id            // also the bus idempotency key
  organizationId String
  appId          String
  agentId        String?
  userId         String?                     // on-behalf-of (D-2026-07-04-C)
  // Trigger provenance (audit: "what caused this run")
  triggerKind    String                      // 'schedule' | 'webhook' | 'manual' | 'integration'
  triggerId      String?                     // AgentSchedule.id / AgentWebhook.id / null
  entryNodeUrn   String                      // the prompt node executed (D12/D17)
  eventData      Json?                       // trigger payload (webhook args, schedule context)
  // Activation (D-2026-07-04-D): this row IS the activation token
  policy         Json?                       // run-layer allow-list snapshot (narrowest chain link)
  budgetTokens   Int?                        // remaining LLM tokens; live-decrement kill switch
  budgetActions  Int?                        // remaining tool/write actions
  // Lifecycle (D11 + D20/D24)
  status         AppRunStatus @default(PENDING)
  curNodeUrn     String?                     // position; retained through terminal state
  parentRunId    String?                     // spawn lineage (post-v1 writes it; column now)
  failure        Json?                       // typed failure payload (observable, D20)
  timeoutMs      Int?
  attempts       Int          @default(0)
  publishedAt    DateTime?                   // outbox marker (039 §4 idiom)
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt      DateTime     @default(now())
  createdBy      String?

  @@index([status, publishedAt])
  @@index([appId, createdAt])
  @@map("app_runs")
}

model AgentSchedule {
  id             String    @id
  organizationId String
  appId          String
  agentId        String?
  userId         String?                     // on-behalf-of, captured at creation (C)
  name           String
  cron           String                      // 5-field cron
  timezone       String    @default("UTC")
  entryNodeUrn   String                      // prompt node to run (D17)
  eventData      Json?                       // static payload merged into each run
  policy         Json?                       // trigger-layer allow-list (chain link)
  aiConfigName   String?                     // per-trigger AI config override (mirrors webhook D5)
  enabled        Boolean   @default(true)
  lastRunAt      DateTime?
  nextRunAt      DateTime?                   // computed; the scheduler's work signal
  createdBy      String?
  createdAt      DateTime  @default(now())
  deletedAt      DateTime?

  @@index([enabled, nextRunAt])
  @@map("agent_schedules")
}

// AgentWebhook: exactly the decided D-2026-05-02 shape (Day 3):
// { id, agentId/appId/orgId, name, secret, argsSchema?, entryNodeUrn,
//   aiConfigName?, userId? (on-behalf-of), policy?, enabled, ... }

model QuotaCounter {
  id        String   @id
  scopeKind String                           // 'app' | 'org'
  scopeId   String
  action    String                           // 'run.execute' | 'llm.tokens'
  window    String                           // 'day'
  used      Int      @default(0)
  limit     Int
  resetAt   DateTime
  @@unique([scopeKind, scopeId, action, window])
  @@map("quota_counters")
}

model ActionTicket {
  id             String    @id
  organizationId String
  appId          String?
  action         String                      // v1: 'comm.outbound'
  mintedBy       String
  note           String?                     // ledger legibility ("where did they go?")
  consumedByRunId String?
  consumedAt     DateTime?
  expiresAt      DateTime?
  createdAt      DateTime  @default(now())
  @@index([organizationId, action, consumedAt])
  @@map("action_tickets")
}
```

Notes: single-`id` PKs throughout (no `MODELS_WITHOUT_ID` change). `AppRun` doubles as
outbox row (039 §4 idiom) and activation token (D). Apply via `pnpm db:dev-setup`.

## 4. Authorization flow (the load-bearing sequence)

```
trigger fires (scheduler tick / webhook / mutation)
  1. LAUNCH GATE (cor:acl:050): quota counters have headroom (run.execute), the
     trigger is enabled, the App/Agent/org are live, on-behalf-of user (if any)
     still has the required relationship (AppMember/AgentSubscription).
  2. MINT: create AppRun(PENDING) — policy snapshot = conjunction-ready chain links
     (org defaults ∧ user link ∧ app link ∧ trigger.policy), budgets from quota
     headroom. Tx-commit, then bus.publish('run.requested.v1', {runId},
     {idempotencyKey: runId}); publishedAt NULL on failure → sweep republishes.
  3. CLAIM (listener): atomic PENDING→RUNNING flip (the #489 idiom). Duplicate
     delivery ⇒ claim count 0 ⇒ ack+drop.
  4. EXECUTE: every action inside the run — LLM call, node write, tool use —
     passes evaluatePolicyChain(action, chain) AND decrements the live budget on
     the AppRun row. Zero budget or status=CANCELLED ⇒ halt (the kill switch).
     Writes go through writeNodeCore under Context{appId, userId?} — the class
     gates apply unchanged (a run with no userId cannot touch personal memories).
  5. FINISH: COMPLETED/FAILED/TIMED_OUT + failure payload + UsageEvent(tokens).
```

`evaluatePolicyChain(action, links[])`: `links.every(l => allows(l, action))` where a
missing link layer contributes the platform default for that layer (A: shape now — the
allow() over JSON allow-lists; the rule language grows inside this signature).

Action vocabulary v1: `run.execute`, `llm.invoke`, `memory.read`, `memory.write`,
`comm.outbound` (ticketed), `tool.<name>` (reserved).

## 5. Bus contract

- Subject `run.requested.v1` (stream RUN), payload `{ runId }` — IDs only, never
  content (encrypted-memory rule; also keeps messages tiny). Idempotency key = runId.
- Listener: same-process (`src/jobs/appRuns.ts`), queue group `run-worker`, claim →
  execute → ack; transient infra failure → throw (nak, spaced redelivery); run-level
  failures are recorded on the row and ACKED (a failed run is a result, not a retry).
- Sweep loop (60s): republish unpublished PENDING rows; reap RUNNING rows past
  lease/timeout → TIMED_OUT (D24). Works with the bus off (D-2026-06-17-004).

## 6. Runner kernel (Day 2, `src/jobs/appRuns.ts` + `src/lib/llm/`)

1. Load AppRun + entry node; assemble instructions with the EXISTING runTask core
   (placeholder substitution over eventData/run context + dependency inlining).
2. `src/lib/llm/index.ts` (net-new): `generateText(resolved, {system, prompt, maxTokens})`
   via Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + bedrock; glm via
   openai-compatible). Config: `resolveAiConfigWithFallback` — trigger's aiConfigName,
   else the walk. Token budget passed as maxTokens ceiling; actual usage decremented +
   recorded on UsageEvent.
3. Output handling v1: the entry node's `data.output` declares the destination —
   `{ writeTo: <nodeUrn>, mode: 'replace'|'append' }` — written via `writeNodeCore`
   ('upsert') under the run Context. No tool loop in v1 (F); the LLM produces text.
4. Failure taxonomy: entry missing → FAILED(D20); assembly/mustache error → FAILED
   (D15-sub); LLM transient → retry within attempts cap; timeout → TIMED_OUT.

## 7. Scheduler (Day 2, `src/jobs/scheduler.ts`)

In-process loop (60s): claim due rows (`enabled AND nextRunAt <= now()` with atomic
update — multi-instance-safe), run the §4 sequence per row, compute nextRunAt via
`cron-parser` (tiny, zero-dep — flag to Holger in PR). Misfire policy v1: run once if
overdue, never backfill multiple missed ticks. Overlap policy v1: skip if a PENDING/
RUNNING run exists for the same schedule (idempotency for overlapping ticks — the
reserved D-2026-05-09 question, answered minimally).

## 8. Webhook trigger (Day 3, decided shape)

`POST/GET /hooks/:secret/:name` → constant-time secret lookup → platform JWT check
(`hpt` param, D-2026-05-02-006) → argsSchema validation → §4 sequence → 202 + runId;
optional callbackUrl POSTed on terminal status (outbound ⇒ consumes a `comm.outbound`
ticket — the first ticketed action, proving tier 2 end-to-end).

## 9. Surfaces (GraphQL, minimal v1)

- `createAgentSchedule / updateAgentSchedule / deleteAgentSchedule` (ADMIN-gated),
  `agentSchedules(appId)` — uniform read surface per cor:api:120.
- `appRun(ref)` / `appRuns(filter, orgId?, limit, offset)` — the AUDIT surface: status,
  trigger provenance, failure, budgets spent, duration. This is the non-techie trust
  view's API; portal UI is Opus work.
- `cancelAppRun(id)` — sets CANCELLED (the kill switch's manual handle).

## 10. Phasing + Opus handoff

| Day | Deliverable |
|---|---|
| 1 (done) | Decisions A–F recorded; this plan; spec nodes (cor:agt:010 runs, cor:acl:050 v1 action cut); schema review with Holger. |
| 2 | Migration + PolicyChain shape + AppRun/AgentSchedule + scheduler + runner kernel + `src/lib/llm` + `run.requested.v1` listener + tests. Demo: a schedule produces a briefing node. |
| 3 | Webhook trigger end-to-end (incl. one ticketed callback) + quota counters live + the Opus handoff node. |
| Opus | Edge-walking runner (D3/D4), spawn (D18/D19), 4-section prompts (D22), schema envelopes (D13/D15), tool loop + tool vocabulary, inbound integrations (email/Slack/Telegram → run.requested), portal audit UI, rule authoring, PoP tokens, share-grantee read completion, `getAccessibleMemoryIds` ADMIN hardening, Sentry (#490), event pivot (`node.written.v1`). |

## 11. Open items intentionally NOT re-decided here

Processor-deny protocol (Q-2026-06-19-001), NATS account tenancy V2, multi-user
active-user runtime, run-time prompt pinning (D25 accepted as-is), memory-write
conflict semantics during runs.
