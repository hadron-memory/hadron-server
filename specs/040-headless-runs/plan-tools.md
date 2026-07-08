# Implementation Plan — Tool Loop for Headless Runs (structured tools)

**Extends:** [`plan.md`](./plan.md) §10 ("Opus handoff": *tool loop + tool vocabulary*) and
[`plan-multi-node.md`](./plan-multi-node.md) (the edge-walking runner this builds on).
**Feature:** A flow node's LLM call can invoke platform tools — create/update/read Hadron
nodes, log, deliberately fail — inside a bounded multi-step loop. This turns flows from
pipelines (text in → text out → one write) into agents that *act*, under the same
policy/budget/kill-switch contract every other run action already obeys.

**Date:** 2026-07-07 · **Status:** Draft for review (Holger). Written with full context of
the live multi-node runner (PRs #532/#535/#536/#537/#539) and the alpha flow-lab
experiment that motivated it ("we will have to add structured tools to make this all
useful — e.g. creating a Hadron node").

**IMPLEMENTED 2026-07-08.** Phases 0–1: PR #540 (spike: bedrock tool-calling healthy —
the #535 hang is generateObject-only; registry + hadron_log/hadron_fail +
generateWithTools). Phases 2–3: PR #545 (kernel wiring, node tools with full MCP arg
parity; review round added auth-before-probe on reads/creates + typed
NoToolSupportError). Phase 4 validated live on alpha 0.0.406: the flow-lab urgent-triage
branch created `triage:tasks:micromentor-search-outage` via hadron_create_node — gated,
budgeted, on the hop trail. Remaining: phase 5 follow-ups (portal tool-picker note in
#478, docs #112 addition, CLI surfacing).

---

## 1. Grounding — decided design this implements (do not re-decide)

| Source | What it dictates here |
|---|---|
| **D-2026-05-09-014** | Tools are declared **per prompt-Node** (`Node.tools: string[]`), not per agent/event — per-call minimization has security value (the node that drafts an email must not hold `send_email`; only the explicit "send" node does). The platform additionally injects a small **always-on set** (candidates pinned: `hadron_log`, `hadron_fail`, time helpers; final membership is spec-time). |
| **D-2026-05-09-021** | v1: **any tool exception terminates the run FAILED**. The reserved `error.*`/`timeout.*` edge prefixes are NOT implemented — edge-routed exception handling is v2, on usage signal. |
| **D-2026-06-19 / cor:acl** | Tools are **action-vocabulary entries**: `tool.<name>` is already reserved in `PolicyAction` (`src/lib/policy/index.ts` — `` `tool.${string}` ``). Conjunctive allow-only chain, default-deny per present link; the activation row (budgets + status) is re-checked on every action. |
| **D-2026-07-04-C** | Tool handlers execute under the run principal `Context{appId, userId?}` — the memory class gates apply unchanged; a run without an on-behalf-of user cannot touch personal/private memories, by construction. |
| **plan-multi-node D-MN-3/-5** | Per-hop action accounting and the checkpoint/trail are the substrate: tool calls are actions *within* a hop; the hop trail (#538/#539) is where their audit record belongs. |

## 2. Substrate inventory (what already exists — verified)

| Piece | Location | Status |
|---|---|---|
| `tool.<name>` in the policy action vocabulary | `src/lib/policy/index.ts` | **Built** — typed, evaluated by `allows()`; no call site passes one yet. |
| Per-action activation re-check + `budgetActions` atomic decrement | `checkActivation()` in `src/jobs/appRuns.ts` | **Built.** Tool calls reuse it verbatim with `action: 'tool.<name>', actionCost: 1`. |
| Node write core under an arbitrary principal | `writeNodeCore` (used by `deps.writeOutput`) | **Built** — the first tool's handler is a thin wrapper. |
| Run principal construction | `runContext()` in `src/jobs/appRunDeps.ts` | **Built.** |
| LLM layer with provider dispatch + transient classification | `src/lib/llm/index.ts` | **Built** for single-shot text + extraction. The tool loop is the third entry point, same dispatch. |
| AI SDK v7 multi-step tool loop | `ai` package (`generateText` + `tools` + step limit) | **Available** — exact stop-condition surface (`stopWhen`/`stepCountIs` vs legacy `maxSteps`) to be pinned at implementation. |
| Per-hop trail | `AppRun.hops` (#539) | **Built** — extension point for per-hop tool-call audit. |
| Failure taxonomy + observable FAILED runs | kernel `fail()` codes | **Built** — add `TOOL_FAILED`. |

**Net-new:** a tool registry, the loop wrapper in `src/lib/llm`, per-call governance glue in
the kernel, and the tool declarations on nodes. No schema migration required for v1 (see
D-TL-1).

## 3. Decisions to lock before coding

### D-TL-1 — Tool declaration lives at `Node.data.tools` (deviation from D14's letter, keeping its spirit)
D14 says a top-level `Node.tools` column. The multi-node build established the flow-node
convention that per-node runner config rides the `data` bag (`data.extractionSpec`,
`data.output`) — no migration, no column churn while the shape settles, and the portal
node editor already round-trips `data`. **v1: `data.tools: string[]`.** Revisit a
promoted column when the portal tool-picker (#478 phase 2) needs queryability
("which nodes may call hadron_create_node?"). Flagged as a deliberate deviation for review.

### D-TL-2 — v1 tool set (small, all platform-internal)
| Tool | Handler | Action checked | Notes |
|---|---|---|---|
| `hadron_create_node` | `writeNodeCore` create under run principal | `tool.hadron_create_node` + `memory.write` semantics via class gates | **Full MCP-tool arg parity** (Holger review 2026-07-07): urn, name, content, nodeType?, data?, **seq?**, tags?, description?, abstract?, properties?, isRunnable? — the flow use cases need the whole surface (e.g. `seq` when appending a chat message so ordering is explicit). Tenant-scoped memory resolution (same `loadFlowNode` posture: same-org only, encrypted denied). |
| `hadron_update_node` | `writeNodeCore` update | `tool.hadron_update_node` | Same full arg surface as create, all optional except urn (merge semantics documented; `data` merges shallow like `hadron_update_node_data`). |
| `hadron_read_node` | node read under `canReadMemory` | `tool.hadron_read_node` (cost 0 — reads are budget-free today) | Returns content + data; encrypted memories denied (no session key). |
| `hadron_log` (always-on) | append `{ts, message}` to the current hop's trail element | none (cost 0) | The author's printf; visible in the portal timeline. |
| `hadron_fail` (always-on) | terminate run `FAILED({code: 'AUTHOR_FAIL', message})` | none | The deliberate abort — distinct from `TOOL_FAILED`. |
Time helpers (D14's third candidate) are **not tools** — inject `now`/`today` into the
merged view instead (they're already evaluator builtins; symmetry is cheaper than a tool).

**Naming convention (locked, Holger review 2026-07-07):** run tools follow the MCP tool
convention — `hadron_` prefix, snake_case (`hadron_create_node`, not `h-create-node`).
One vocabulary across MCP and the run tool loop: an author who knows one surface knows
the other, and future MCP↔run-tool sharing has no rename seam. Policy entries follow:
`tool.hadron_create_node`.

### D-TL-3 — Per-call governance inside the loop
Every tool execution wraps: `checkActivation(db, runId, 'tool.<name>', {actionCost: 1})`
(cost 0 for reads/log per D-TL-2). Denial (policy, cancellation, exhausted actions) aborts
the loop → run fails `ACTIVATION_DENIED` — the kill switch now halts *mid-hop*, not just
between hops. This is the payoff of the activation-row design: no new mechanism, one more
call site.

### D-TL-4 — Loop bounds
`RUN_MAX_TOOL_STEPS_PER_HOP` (env, default **8**). The hop deadline (run `timeoutMs`)
still applies; `budgetActions` (50) caps total actions across the flow. Exceeding the
step cap is not an error — the loop ends and the last text becomes the hop result
(matching AI SDK semantics); authors who need more steps raise the env or split nodes.

### D-TL-5 — Tools × extraction are mutually exclusive per node (v1)
A node declares `data.extractionSpec` **or** `data.tools`, not both. The extraction path
stays the single-shot `generateExtraction`; the tool loop is text-mode only. Both on one
node → loud `NODE_LOAD_FAILED` at hop start. v2 may allow "act, then extract from the
transcript" if flows demand it. Rationale: the bedrock lesson (#535) — one new provider
surface at a time, and the interaction (structured output *of* a tool transcript) is
exactly where SDK/provider support is shakiest.

### D-TL-6 — Failure taxonomy
- Handler throws → `FAILED({code: 'TOOL_FAILED', tool, message})` (D21). No retry — tool
  side effects are not known-idempotent, so transient-style redelivery is NOT safe here
  (contrast with the pure-LLM transient path). A thrown *provider* error before any tool
  executed keeps the existing `LLM_FAILED`/transient behavior.
- Unknown name in `data.tools` → `NODE_LOAD_FAILED` at hop start (fail before the LLM
  call, same posture as the `__`-field and encrypted-hop guards).
- `hadron_fail` → `FAILED({code: 'AUTHOR_FAIL'})` — intentional, reads differently in audit.

### D-TL-7 — Trail record
Each hop element (#539) gains `toolCalls: [{name, ok, ms}]` (+ `hadron_log` messages as
`{name: 'hadron_log', message}`). Bounded by D-TL-4 (≤8/hop), so no growth concern. The portal
timeline renders it under the hop.

### D-TL-8 — Provider gating (the #535 lesson, applied proactively)
Phase 0 is an empirical spike: one tool-call round-trip per provider (anthropic, bedrock,
openai; glm excluded like extraction). Providers that fail/hang land in a
`TOOL_LOOP_PROVIDERS` allow-set (mirror of `JSON_PROMPT_ONLY_PROVIDERS`); a tools-declaring
node on an unsupported provider fails loud at hop start (`NO_TOOL_SUPPORT`) rather than
degrading silently — tools change semantics, so silent fallback to no-tools is wrong.
Native attempts get an abort cap like extraction's.

**Phase-0 result (2026-07-07, `scripts/spike-tool-loop.mjs` against live bedrock):**
bedrock `us.anthropic.claude-sonnet-4-6` completes a tool round-trip in 4.4s — 2 steps,
correct args, final text uses the tool result. The #535 hang is specific to
`generateObject`; tool-calling is healthy. `TOOL_LOOP_PROVIDERS = {anthropic, openai,
bedrock}` (glm excluded). SDK surface pinned: `tool()` + `jsonSchema()` +
`stopWhen: stepCountIs(n)`; summed usage via `totalUsage ?? usage`.

## 4. Runtime shape

```
hop start:
  spec = loadNodeSpec(...)                      # + data.tools validation (D-TL-6)
  if spec.tools:
    registry = resolveTools(spec.tools + ALWAYS_ON)
    result = llmWithTools(resolved, req, registry, {
      onToolCall: (name) => checkActivation(runId, `tool.${name}`, cost)  # D-TL-3
      stepCap: RUN_MAX_TOOL_STEPS_PER_HOP                                  # D-TL-4
    })
    # result: {text, tokensIn/Out (summed across steps), toolCalls[]}
  else: existing generateText / generateExtraction paths, unchanged
  ... envelope/route/write/checkpoint exactly as today; hops element += toolCalls
```

`llmWithTools` lives beside `generateText`/`generateExtraction` in `src/lib/llm/index.ts`
— same provider dispatch, same token accounting (usage summed across steps, decremented
once per hop as today), same `isTransient` classification for pre-tool provider errors.
Handlers receive `(runContext, args)` and are plain async functions in
`src/lib/runner/tools/` — one file per tool, a registry index, unit-testable without LLM.

## 5. Phasing

| Step | Deliverable | De-risked by |
|---|---|---|
| 0 | **Provider spike**: scripted tool round-trip per provider against real endpoints; pin `TOOL_LOOP_PROVIDERS` + the AI SDK stop-condition API. | #535 made the cost of skipping this concrete. |
| 1 | Registry + `hadron_log`/`hadron_fail` + `llmWithTools` (unit tests with mocked SDK). | Handlers are pure functions. |
| 2 | Kernel integration: `data.tools` load/validation, D-TL-3 per-call gate, `TOOL_FAILED`/`AUTHOR_FAIL`/`NO_TOOL_SUPPORT` codes, trail `toolCalls`. Existing no-tools flows byte-identical. | Tools opt-in, same pattern as extraction. |
| 3 | Node tools: `hadron_read_node`, `hadron_create_node`, `hadron_update_node` under the run principal + integration test (flow creates a real node; personal-memory denial test). | `writeNodeCore`/`canReadMemory` battle-tested. |
| 4 | Live flow-lab validation: extend the triage flow — the alert branch *creates a task node* via `hadron_create_node` instead of only appending text. | The alpha experiment loop from 2026-07-07. |
| 5 | Follow-ups: portal #478 tool-picker note, docs #112 reference addition, CLI surfacing. | — |

## 6. Explicitly out of scope (v1)

`spawn`/fan-out (D18/D19); external/MCP tools and any network-egress tool (first ticketed
`comm.outbound` action is its own slice — the ticket ledger exists, but outbound is a
policy conversation, not a code slice); `error.*`/`timeout.*` edges (D21 v2); tools inside
extraction nodes (D-TL-5); per-tool rate limits beyond the action budget.

## 7. Test fixture sketch

Triage-extended: `flow:act` declares `data.tools: ["hadron_create_node"]`, prompt instructs
"create a task node under `<org>::<memory>::tasks:` for the next action". Assert: node
exists with run-principal `createdBy`, `hops[1].toolCalls == [{name: 'hadron_create_node', ok: true, ...}]`,
`budgetActions` decremented for the call, and the same flow with a policy chain lacking
`tool.hadron_create_node` fails `ACTIVATION_DENIED` mid-hop **before** the node exists.
