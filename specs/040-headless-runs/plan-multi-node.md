# Implementation Plan — Multi-Node Headless Runs (edge-walking runner)

**Extends:** [`plan.md`](./plan.md) §10 ("Opus handoff", item 1: *Edge-walking runner (D3/D4)*).
**Feature:** Turn the shipped single-entry-node kernel into a runner that walks a graph —
run a node, extract structured data into the run envelope, follow the first firing
conditional edge, repeat until no edge fires. This is what makes headless runs *automations*
rather than one-shot prompts.

**Date:** 2026-07-06 · **Status:** Draft (Holger) → reviewed + detailed by Claude Fable 5
2026-07-06. Review verdict: sound and buildable; two correctness gaps fixed below
(D-MN-4 routing-edge filter, D-MN-5 checkpoint/resume) and the bus section (§4a) added.

---

## 1. Grounding — decided design this implements (do not re-decide)

From [2026-05-09-headless-agent-runner](https://github.com/hadron-memory/hadron-concept/tree/main/design-discussions/hadron-platform/2026-05-09-headless-agent-runner):

| Decision | What it dictates here |
|---|---|
| **D3 / D4** | Routing happens ONLY on edges (JSONLogic conditions), never inline LLM branching. Mustache shapes *content*; conditional edges decide *whether/which* next node. |
| **D7** | Edge naming `next[.<index>][.<name>]`; selection order: explicit `Edge.priority`, else numeric `<index>`, else lexical `loc`. **No firing edge ⇒ run terminates COMPLETED** (not failed). |
| **D13** | Run envelope seeded at start; each hop *extends* the envelope from the node's declared schema/extraction-spec. Run-scoped read cache. |
| **D17** | Every node in the flow (entry or interior) is a prompt Node — same `content`/`data`/tools shape. |
| **D22** | 4-section system prompt composition — **out of scope here**, stays in §10 backlog. v1 keeps the flat system string the kernel uses today. |

**Envelope location (confirmed with Holger 2026-07-06):** extracted data lives in
**`AppRun.data`**, NOT in a graph node. The root node is typically in a `system`-class
memory the App can't write to; the envelope is run-scoped mutable state. `eventData` stays
the immutable trigger payload; `data` is the mutable accumulator.

## 2. What already exists (substrate inventory — the good news)

| Piece | Location | Status |
|---|---|---|
| Trigger → auth → budget → LLM → record spine | `src/jobs/appRuns.ts` (`executeAppRunInner`) | **Built.** Single node only. |
| Edge-condition evaluator (JSONLogic, validation, var pre-resolution) | `src/lib/edge-conditions/evaluator.ts` (`evaluateEdgeCondition`) | **Built + production-wired** (chat transitions call it in `resolvers.mutation.chat.ts`). |
| Edge model with `condition` (JSONLogic), `priority`?, `loc`, `isRunnable` | `prisma/schema.prisma` `model Edge` | **Built.** |
| Extraction-spec shape + validation (`extractionSpec` → `message.data.<field>`) | `src/lib/edge-conditions/reserved-names.ts` | **Shape built; no runtime extractor yet.** |
| Per-action activation re-check + live budget decrement | `checkActivation()` in `appRuns.ts` | **Built.** Already called per action — the loop reuses it per hop. |
| Instruction assembly (template + dependency inlining) | `deps.assemble` (runTask core) | **Built.** |
| `curNodeUrn` position column | `AppRun.curNodeUrn` | **Built.** Currently only written at terminal. |

**Net:** the loop, one schema column, and an extractor. The evaluator, the budget/kill-switch
contract, and the position column are done.

## 3. Decisions to lock before coding (3 real choices)

### D-MN-1 — Envelope → evaluator scope mapping (the namespace-reconciliation question, Q4a)
The evaluator resolves variables from fixed scopes: `memory.*`, `chat.*`, `agent.*`,
`message.data.*`, `now()`/`today()`. The run envelope needs a home among these.

**Recommendation: map the envelope to `message.data.*`.** Rationale:
- The extraction-spec format (`reserved-names.ts`) *already* writes each field to
  `message.data.<field>` — the convention exists and is validated.
- The evaluator's `EvaluateRequest.messageData` bag is the exact injection point (line 27-28).
- Zero evaluator changes: pass `messageData: appRun.data` and edge conditions written as
  `var("message.data.confidence")` just work.
- Keeps the headless and chat surfaces on ONE variable model — no scope fork.

Alternative (add a `run.*` / `data.*` scope) is rejected: forks the evaluator's scope
allow-list, and the UI would then have two "where does my extracted field live" stories.

**Two details this decision needs (filled in on review):**
- **Storage vs scope path:** `AppRun.data` stores the BARE field bag (`{confidence: 0.9}`).
  `message.data.` is the evaluator's scope *prefix*, not a storage path — conditions say
  `var("message.data.confidence")`, the DB row says `data: {confidence: 0.9}`. (§10's
  original assertion had these nested; fixed.)
- **What conditions and templates can see:** the trigger payload should be branchable too
  (a webhook arg deciding the first hop is the obvious case). Evaluation view =
  `{...run.eventData, ...envelope}` — the envelope wins on key collision (extracted facts
  override trigger hints; eventData itself stays immutable). The SAME merged view feeds
  `deps.assemble` as template args, so templates and conditions never disagree about a
  field's value.

### D-MN-2 — How extraction happens
The node produces text; we need structured fields in the envelope. Options:
- **(a) Structured-output pass (recommended):** if a node declares `data.extractionSpec`,
  the runner makes the LLM call in structured-output mode (Vercel AI SDK `generateObject`
  with a schema derived from the spec's `field`/`shape` entries) and merges the object into
  `AppRun.data` under `message.data.*`. One call, no second round-trip.
- (b) Second extraction call after a free-text generation. Simpler prompt-wise, doubles
  token cost per extracting node. Reject for v1.
- **A node with no `extractionSpec` behaves exactly like today** (free text → `writeOutput`).
  Extraction is opt-in, so existing single-node runs are unaffected.
- **Shape vocabulary (filled in on review):** `ExtractionSpec.shape` is a free string today
  (`reserved-names.ts` validates only `field`). Define the v1 mapping to the
  `generateObject` schema explicitly: `'number'` → z.number(), `'boolean'` → z.boolean(),
  `'string[]'` → z.array(z.string()), anything else / absent → z.string(). Every field
  optional-nullable (the model may not find it); unknown shapes never throw — they degrade
  to string. Also: `generateObject` needs a new `src/lib/llm` wrapper beside
  `generateText` — same provider dispatch, same token accounting into the budgets, same
  `isTransient` handling. Verify bedrock/glm structured-output support in the AI SDK and
  fall back to (b)-style one-shot JSON-mode prompting for providers without native
  support — inside the wrapper, invisible to the runner.

### D-MN-3 — Loop safety bound
Cyclic graphs and runaway flows must terminate. Add `MAX_RUN_HOPS` (env, default e.g. 50).
Exceeding it → `FAILED(code: 'MAX_HOPS_EXCEEDED')`, observable per D20. The token/action
budgets already provide a cost ceiling; hops guard against zero-cost infinite loops (a node
that writes and routes without an LLM call). Note the interplay: `budgetActions`
(default 50) is the REAL ceiling for LLM hops — MAX_RUN_HOPS only matters for hops that
skip the LLM.

### D-MN-4 — ONLY `next*` edges route (correctness fix from review)
A node's outgoing edges include documentation/dependency edges (`documents`,
`depends-on`, …) whose `condition` is null — and a null condition means "always fires."
Without a filter, the walker would follow a `documents` edge into a dependency and run it.
**`selectNextEdge` participates ONLY edges whose D7 name matches `next` or
`next.<index>[.<name>]`** (match on `Edge.name`, fall back to the loc's derived segment).
Everything else is invisible to routing. This also means graph authors can freely document
flow nodes without breaking the flow.

### D-MN-5 — Per-hop checkpoint = resume semantics (the bus made this decision necessary)
`AppRun.data` + `curNodeUrn` are persisted AFTER each hop's side effects commit — together
they are the run's CHECKPOINT. Consequences, locked here:
- `curNodeUrn` changes meaning from "terminal result ref" to "checkpoint: the NEXT node to
  execute" (live position mid-run — the audit screen gets a progress feature for free; the
  terminal write keeps its current value at completion).
- The transient-LLM → PENDING reset (kernel line ~547) now RESUMES from the checkpoint on
  redelivery instead of restarting at the entry node — no re-execution of completed hops,
  no duplicate side effects. Loop start: `cur = run.curNodeUrn ?? run.entryNodeUrn`,
  `envelope = run.data ?? {}`.
- At-least-once granularity becomes **one hop**, not one flow: a crash between a hop's
  side effects and its checkpoint re-runs exactly that hop on recovery. Hop side effects
  are idempotent-enough: `writeOutput` upserts a derived loc (same target), envelope merge
  is last-write-wins on the same fields. Document; don't fight it.
- Timeout stays per-ATTEMPT wall clock (deadline recomputed at each claim — existing
  single-node behavior, unchanged).

## 4. Runtime work — the edge-walking loop

**File:** `src/jobs/appRuns.ts`. Refactor `executeAppRunInner` (currently lines ~480–614):
lift the assemble→activation→LLM→write block into a per-node step function, wrap in a loop.

```
executeAppRunInner:
  claim PENDING→RUNNING                                  # unchanged (idempotent claim)
  deadline = now + timeoutMs                             # per-ATTEMPT, as today
  cur      = run.curNodeUrn ?? run.entryNodeUrn          # D-MN-5: resume from checkpoint
  envelope = run.data ?? {}                              # D13 seed (empty bag)
  for hop in 0..MAX_RUN_HOPS:
    if now >= deadline: finish TIMED_OUT                 # per-hop deadline check
    node = loadNode(cur)                                 # run-scoped cache (D13)
    checkActivation('llm.invoke', cost=1)                # unchanged contract, per hop
    view = {...run.eventData, ...envelope}               # D-MN-1: the merged view
    instructions = deps.assemble(run, node, view)        # view = template args
    result = deps.llm(...)                               # generateText OR generateObject (D-MN-2)
    decrement budgets + recordQuotaUsage                 # unchanged (transient → PENDING,
                                                         #   redelivery resumes HERE via checkpoint)
    if node has extractionSpec:
       envelope = merge(envelope, result.object)         # bare fields into AppRun.data
    if node declares data.output:                        # existing writeOutput path
       checkActivation('memory.write'); deps.writeOutput(node, result.text)
    next = await selectNextEdge(node, {...run.eventData, ...envelope})   # §5, D-MN-4 filter
    persist AppRun{ data: envelope,                      # D-MN-5: CHECKPOINT — after side
                    curNodeUrn: next?.targetUrn ?? cur } #   effects, before the next hop
    if next == null: break                               # D7: no firing edge → done
    cur = next.targetUrn
  finish COMPLETED + UsageEvent                          # unchanged
```

Access-control note (came out of review, no code needed): interior nodes may live in
DIFFERENT memories than the entry (cross-memory edges). Each hop's `deps.assemble`
delegates to the runTask resolver under the run's principal, so per-memory read auth is
enforced per hop automatically; a flow routed into a memory the agent lacks fails there
with the normal assembly failure — observable, correct, nothing special to build.

Every existing guard (concurrent-cancel, timeout deadline, transient-LLM → PENDING requeue,
activation re-check) stays — it just runs **per hop**. The kill switch and budget decrement
already re-check every action, so a mid-flow `cancelAppRun` halts at the next hop for free.

## 4a. What the message bus changes — and deliberately doesn't (filled in on review)

The draft predates the bus idioms; here is the reconciliation. Short version: **v1 keeps
the in-process loop and rides the bus contracts we already have; hop-per-message is the
designed v2, with explicit triggers.**

**What multi-node inherits from the bus for free:**
- **Duplicate delivery is already safe.** `run.requested.v1` is at-least-once; the atomic
  PENDING→RUNNING claim makes a duplicate delivery a no-op while an attempt is live. The
  loop changes nothing here.
- **Transient-LLM retry gets BETTER.** Today's transient → PENDING reset + bus redelivery
  restarts the (single) node. With the D-MN-5 checkpoint, redelivery resumes at the failing
  hop — completed hops never re-run. This is the main bus-facing payoff of the checkpoint
  and the reason it is persisted per hop rather than at terminal only.
- **The kill switch stays bus-independent.** `cancelAppRun` / budget-zeroing halt at the
  next hop via `checkActivation` — same contract, now per hop.

**The one real constraint: `ack_wait` (120s) vs flow duration.** The bus listener executes
the run INSIDE the message handler, so the broker starts redelivering while a long flow is
still running. The claim makes those redeliveries harmless no-ops (and `max_deliver` caps
them), but they are wasted deliveries and they mean the bus's retry machinery is blind
past 120s. **v1 guidance: keep `timeoutMs` ≤ ack_wait (the defaults already agree at
120s)** — a briefing-class flow of 3-10 hops fits comfortably. Do NOT raise ack_wait to
paper over long flows.

**The v2 evolution — hop-per-message (design it now, build it on trigger):** instead of
looping in-process, each hop ends by publishing `run.requested.v1` again and acking; the
next delivery claims the checkpoint and executes ONE hop. Every bus property then applies
per hop: ack_wait bounds a hop (not a flow), redelivery granularity is a hop, a process
death mid-flow resumes on the next delivery with no reaper involvement, and work
distributes across instances mid-flow. The D-MN-5 checkpoint is exactly the state this
needs — v1 builds the persistence, v2 only changes WHO drives the loop. *Triggers for v2:
flows that legitimately exceed ~2 minutes; spawn/fan-out (D18/D19 — children are just N
published messages with `parentRunId`); remote runners.*

**Crash recovery in v1 (honest statement):** a process death mid-flow leaves the run
RUNNING until the sweep's timeout reaper marks it TIMED_OUT (existing D24 behavior — a
crash is indistinguishable from a hang without a heartbeat, which v1 does not add). The
checkpoint means a manual or future-automated re-trigger could resume rather than restart,
but v1 does not auto-resume TIMED_OUT runs. Hop-per-message (v2) dissolves this case.

**Events:** do NOT mint `evt.run.hop.v1` (or similar) yet — per the event conventions
(`findings:bus-module-conventions`), a subject exists when a second consumer does. The
portal audit screen reads `curNodeUrn` from the row; that is enough.

## 5. Edge selection (`selectNextEdge`) — new, thin

New helper (`src/lib/runner/selectNextEdge.ts` or inline). Reuses the built evaluator.

```
selectNextEdge(node, view):
  edges = outgoing edges of node                         # Edge.sourceId = node.id
  edges = edges.filter(isRoutingEdge)                    # D-MN-4: name matches next[.<i>][.<name>]
                                                         #   — documents/depends-on edges NEVER route
  # D7 ordering: priority DESC (nulls last), then numeric <index> from loc, then loc lexical
  edges.sort(byPriorityThenIndexThenLoc)
  for e in edges:
    r = await evaluateEdgeCondition({
          condition: e.condition,                        # null ⇒ always fires
          edge: { id: e.id, sourceNodeUrn: sourceUrn },
          memoryLayers: [sourceNodeMemoryLayer],
          agent: agentBag,
          messageData: view,                             # D-MN-1: {...eventData, ...envelope}
        })
    if r.ok && r.fired: return { edge: e, targetUrn: e.targetUrn }
    if !r.ok: FAIL run (EDGE_CONDITION_ERROR, e.id)      # D15-sub: evaluation error terminates
  return null                                            # no edge fired → terminate COMPLETED
```

Mirror the `memoryLayers` / `agent` bag construction already done in
`resolvers.mutation.chat.ts` — that call site is the reference implementation.

## 6. Schema change (one migration)

```prisma
model AppRun {
  // ...existing...
  data  Json?  @map("data")   // D13 run envelope (mutable); message.data.* scope. eventData stays immutable.
}
```

Apply via `pnpm db:dev-setup`. Non-breaking (nullable). Existing rows unaffected.

## 7. The UI challenge (Holger's flagged priority — non-techie condition authoring)

Target users must NOT write JSONLogic. The runtime already accepts JSONLogic; the portal
needs a **builder that emits it**. Substrate that helps:
- `src/lib/edge-conditions/validator.ts` — validates the emitted JSONLogic (guardrail).
- `src/lib/edge-conditions/user-messages.ts` — human-readable messages for condition errors.
- Fixed operator set (`operators.ts` `V1_OPERATORS`) — a *closed* vocabulary, so a
  dropdown-driven builder can cover 100% of expressible conditions.

**Recommended v1 UI (portal, on the edge editor):**
- A row-based condition builder: `[field ▾] [operator ▾] [value]`, ANDed/ORed rows.
  - **field ▾** is populated from the *source node's* `extractionSpec` fields (the app
    author declared them when building the node — the UI reads them back). This closes the
    loop: "what can I branch on?" = "what the previous node extracts."
  - **operator ▾** from `V1_OPERATORS` (`==`, `!=`, `>`, `<`, `in`, …).
  - Builder serializes to JSONLogic on save; `validateEdgeCondition` gates the write.
- Edge naming/ordering surfaced as a simple "priority" number + an optional label; the
  `next.<index>` convention is generated, not typed.
- Render a plain-English preview of each edge ("when *confidence* is *greater than* 0.8")
  from the JSONLogic — reuse/extend `user-messages.ts` phrasing.

This is the largest *net-new* surface and the least de-risked; scope it as its own portal
PR. The runtime (§4–5) can land and be tested via API/CLI **before** the UI exists.

## 8. Phasing

| Step | Deliverable | De-risked by |
|---|---|---|
| 1 | Migration: `AppRun.data`. | Trivial, nullable. |
| 2 | `selectNextEdge` + unit tests (D-MN-4 filter, ordering, firing, no-fire→null, eval-error→fail). | Evaluator already built + tested. |
| 3 | Loop refactor of `executeAppRunInner` + `MAX_RUN_HOPS` + D-MN-5 checkpoint/resume (incl. transient-mid-flow resume test). Existing single-node tests must stay green (a 1-node flow with no edges = today's behavior). | Guards unchanged; extraction opt-in. |
| 4 | Extraction: `generateObject` wrapper in `src/lib/llm` (shape mapping per D-MN-2, provider fallback), merge into `AppRun.data`. | Vercel AI SDK native. |
| 5 | Integration test: a 3-node flow (extract → branch high/low → two terminals) driven by a schedule or the CLI runner, asserting the `AppRun.data` accumulation and `curNodeUrn` trail. | Pong example-3 is the canonical shape. |
| 6 | **Portal condition builder** (§7) — separate PR, can trail the runtime. | — |

## 9. Possibly in scope (currently in plan.md §10 backlog)

`spawn`/fan-out (D18/D19 — `parentRunId` column exists but no writer here), 4-section
prompt composition (D22), tool loop + tool vocabulary, inbound integrations, run-time
prompt pinning (D25 as-is). Multi-node ≠ fan-out; this plan is the linear/branching walk
only. A node still makes at most one LLM call per visit.

## 10. Test-graph fixture to build first (mirrors example-3)

```
entry:classify  --(extractionSpec: {intent, confidence})-->
  edge next.1.high  cond: message.data.confidence > 0.8  --> node:act
  edge next.2.low   cond: (none, fall-through)           --> node:defer
```
Assert: `AppRun.data.confidence` populated (bare field — `message.data.` is the
evaluator's scope prefix, not a storage path; see D-MN-1); `curNodeUrn` ends at `act` or
`defer`; run COMPLETED; budget decremented twice (two LLM calls) when it routes to a node
that itself calls the LLM, once when it routes to a terminal that only writes. Add two
regression cases from review: (a) a `documents` edge on `entry:classify` must NOT route
(D-MN-4); (b) kill the run mid-flow (flip status to CANCELLED after hop 1) and assert it
halts at hop 2 with the checkpoint intact.
