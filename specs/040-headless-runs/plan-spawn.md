# Implementation Plan — Spawn / Fan-out for Headless Runs

**Extends:** [`plan.md`](./plan.md) §10 and completes the run-model family
([`plan-multi-node.md`](./plan-multi-node.md) → [`plan-tools.md`](./plan-tools.md) → this).
**Feature:** A flow can fan out — one parent run dispatches N independent child runs
(one per item), each walking its own flow, with an optional callback run when all
children finish and an optional per-child callback as each one finishes. "Process every
unread email" stops being a prompt-engineering wish and becomes a platform primitive.

**Date:** 2026-07-08 · **Status:** Draft; implements decided design D-2026-05-09-018/-019.

---

## 1. Grounding — decided design this implements (do not re-decide)

| Source | What it dictates here |
|---|---|
| **D-2026-05-09-018** | `spawn` has two surfaces: an **LLM-callable tool** `spawn(items, process_item, [callback], [item_callback])` and a tool-internal iteration convention. Dispatch mechanism unconstrained (direct mint, bus, batch). v1 ships the LLM-callable surface — the tool loop (plan-tools) is exactly the delivery vehicle D18 was waiting for. |
| **D-2026-05-09-019** | Children inherit org/app/agent/user from the parent; parent's data is visible to children (v1); per-child `eventData` carries the spawn item (default key `item`, override via `item_key`); `callback` fires ONCE when ALL children reach a terminal status; `item_callback` fires per child as each terminates; callback runs carry `parentRunId` pointing at the original parent. Parent terminates after dispatch — **no WAITING_CHILDREN status** (the callback pattern replaces parent-side waiting). |
| Reserved items (2026-05-09 summary) | `h-children(parentRunId)` aggregation tool → ships here as `hadron_child_runs` (MCP naming convention, locked). Callback parameterization (`callback_on_any_failure` etc.) stays v2 — v1 callbacks fire on any-terminal mix, and the callback node inspects outcomes itself. |
| plan-tools (shipped) | The tool registry, per-call `tool.<name>` activation gate, hop-trail `toolCalls`, and D-TL-6 failure taxonomy — `hadron_spawn` is just another registered tool. |
| Built substrate | `AppRun.parentRunId` column (written by nothing yet); `mintAppRun` launch gate (quota/policy/encrypted/cross-org per child, for free); bus publish + sweep republish; guarded terminal transitions (every terminal flip is a `count===1` updateMany — the natural exactly-once hook). |

## 2. Decisions to lock (D-SP-*)

### D-SP-1 — Spawn config lives on a dedicated `AppRun.spawn` column, NOT in `data`
The parent's envelope (`data`) is checkpointed wholesale by its own loop; a mid-hop spawn
writing config into `data` would be clobbered by the next checkpoint (the walker's
in-memory envelope predates the spawn). New nullable JSONB `spawn` on the PARENT row:
`{ processItem, callback?, itemCallback?, total, callbackFiredAt? }`. No table, no race.

### D-SP-2 — `triggerKind: SPAWN` (enum addition)
Children and callback runs mint with a first-class trigger kind — audit must distinguish
"a flow fanned out" from MANUAL. `triggerId` = the parent run id (provenance parity with
schedules/webhooks).

### D-SP-3 — Child eventData = parent view + item; callbacks marked out-of-band
`child.eventData = { ...mergedView(parent.eventData, parent.data at spawn time), [itemKey]: item }`
— D19's "parent data visible to children" lands as trigger payload, so child templates
and conditions see it through the normal `message.data.*` machinery, and the envelope-
wins-on-collision rule applies unchanged. Callback runs carry
`eventData.__spawnCallback: true` — the `__` prefix keeps the marker OUT of templates
(D-MN-1 stripping) while the completion check can filter on it; the VISIBLE callback
payload is `{ parentRunId, total, completed, failed, timedOut, cancelled }`
(item-callbacks: `{ parentRunId, childRunId, childStatus, [itemKey]: item }`).

### D-SP-4 — Exactly-once callback via an atomic SQL claim
Concurrent child terminals race to be "the last one". The completion check is a single
raw UPDATE: set `spawn.callbackFiredAt` WHERE it is null AND no non-callback child of
the parent is PENDING/RUNNING — rowcount 1 elects exactly one firer. Kernel calls
`handleSpawnCompletion(db, run)` from every terminal-transition site that already
guards with `count===1`: executeAppRun terminals, the sweep's TIMED_OUT reaper, and
`cancelAppRun`. (A cancelled LAST child would otherwise leave the callback unfired
forever — the cancel resolver is a required call site, not a nicety.)

### D-SP-5 — Partial-failure semantics of the spawn call
Items are minted individually through the full launch gate. Per-item denial (quota
exhausted mid-batch, policy) does NOT throw — the tool RETURNS
`{ spawned, denied, deniedReasons }` and the parent flow decides what that means;
already-spawned children are independent runs and never orphan-cancelled. ONLY a
zero-spawned batch throws (→ `TOOL_FAILED`) — a fan-out that fanned out nothing is a
malfunction. Cap per call: `RUN_MAX_SPAWN_ITEMS` (env, default **20**) — quota is the
real ceiling; the cap keeps one prompt from minting the day's budget.

### D-SP-6 — `hadron_child_runs` (the reserved h-children tool)
Cost 0. Args: `parentRunId?` (defaults to the calling run's own `parentRunId` — the
callback's common case needs zero args). Same-app scope enforced. Returns per child:
`{ id, status, data, curNodeUrn, failure }` — enough for the callback to summarize,
retry-decide, or digest. Callback/item-callback runs are excluded from the listing
(they are coordination, not results).

### D-SP-7 — Depth guard
A spawned child whose flow also calls `hadron_spawn` is legal (trees are useful), but
depth is capped: `RUN_MAX_SPAWN_DEPTH` (env, default **2**) walked via `parentRunId`
chain at spawn time. Exceeding → the spawn call is denied (counts toward D-SP-5's
`denied`). Guards the fork bomb the 1000-agent-style backstops exist for.

## 3. Runtime shape

```
hadron_spawn (tool, cost 1) inside any tools-hop:
  validate items[] (≤ RUN_MAX_SPAWN_ITEMS), process_item URN, depth (D-SP-7)
  persist parent.spawn = {processItem, callback?, itemCallback?, total: N}   (D-SP-1)
  for each item: mintAppRun({ triggerKind: SPAWN, triggerId: parent.id,
    parentRunId: parent.id, entryNodeUrn: process_item,
    eventData: {...parentView, [itemKey]: item} })                            (D-SP-3)
    → each child publishes run.requested.v1 (bus) or drains via sweep
  return {spawned, denied, deniedReasons}                                     (D-SP-5)

child terminal (any site that flipped status with count===1):
  handleSpawnCompletion(db, child):
    if child.eventData.__spawnCallback → noop (coordination runs don't recurse)
    if parent.spawn.itemCallback → mint item-callback run (once per child —
      the count===1 guard at the flip site is the idempotency)
    atomic claim (D-SP-4) → if elected: mint callback run with the tally
```

Parent flow simply continues (usually to its terminal) after the spawn hop — D19's
"parent terminates after dispatch". The callback run is a NEW run at the callback node,
typically a tools-hop declaring `hadron_child_runs`.

## 4. Phasing

| Step | Deliverable |
|---|---|
| 1 | Migration: `AppRun.spawn JSONB`, `AppRunTriggerKind += SPAWN`, index on `parent_run_id`. |
| 2 | `hadron_spawn` + `hadron_child_runs` tools + registry; `handleSpawnCompletion` with the D-SP-4 claim; call sites (executeAppRun terminals, sweep reaper, cancelAppRun). |
| 3 | Tests: fan-out mints N children through the real gate; callback fires exactly once under concurrent terminals; item-callbacks once per child; cancelled-last-child still fires; partial denial returns not throws; depth cap; `hadron_child_runs` scope. |
| 4 | Live flow-lab validation: a digest flow — entry spawns 3 note-triage children, callback summarizes via `hadron_child_runs` into a digest node. |
| 5 | Paperwork: portal #478 (children + callback on the run timeline; `parentRunId` linking), docs #112 (fan-out section), GraphQL `appRuns(parentRunId:)` filter if not already expressible. |

## 5. Out of scope (v1)

Tool-internal iteration surface (D18's second surface — no platform tool returns lists
yet); callback parameterization (v2 per the 2026-05-09 reservation); WAITING_CHILDREN
(explicitly replaced by callbacks); cross-app/cross-org children (children inherit the
parent's principal, full stop); concurrency throttling beyond the item cap (the bus
queue-group is the natural distributor; per-app run quotas already bound totals).
