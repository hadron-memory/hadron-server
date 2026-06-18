# Feature Specification: Run Task by Name

**Feature Branch**: `038-run-task-by-name`
**Created**: 2026-06-17
**Status**: Draft
**Input**: User description: "A natural-language task runner. A user says *'run the task X in the Y memory'* and the platform resolves both the runnable node and the memory from loose names — no fully-qualified URN, no clipboard. When the hint is ambiguous or absent, the server presents an interactive selection (MCP elicitation) so the user picks one from a menu; when it is unambiguous, it runs. Execution reuses the existing `h-run-action` load → arg-substitute → dependency-resolve → return core. Targets non-coder Hadron users on Claude Code, including the 'Code' tab of the Claude for Mac app."

## Clarifications

### Session 2026-06-17

- Q: What predicate defines a "runnable" node — `nodeType = 'task'` or the `isRunnable` boolean? → A: **Open — see Assumptions.** Recommended: `isRunnable = true` (the purpose-built flag), with a one-time backfill from `nodeType = 'task'`. The user's stated definition is `nodeType = 'task'`. This is the single decision blocking FR-002.
- Q: New `h-run-task` tool or rename/enhance `h-run-action`? → A: **New tool sharing the resolve core** (see Assumptions). `h-run-action` carries spec 022/024/026 invariants, docs, and a caller; it is left intact.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a task by name without a URN (Priority: P1)

A user tells their agent "run the *add-review-node* task in the *mmdata* memory." The agent forwards the two loose hints to the platform. The server resolves the memory from the accessible set, finds the one runnable node whose name/alias/description/loc matches the task hint within that memory, and executes it — returning the task's instructions with all edge-linked dependencies resolved. The user never types, finds, or pastes a fully-qualified URN.

**Why this priority**: This is the core of the feature — server-side resolution of (memory, task) from loose names, reusing the existing executor. Everything else (disambiguation UI, fallback, scope-widening) builds on it. It is what turns a tool nobody uses (`h-run-action`, which needs a URN you must first hunt down) into a usable entry point.

**Independent Test**: With a memory containing exactly one runnable node matching "add-review-node," call the tool with `task: "add-review-node"`, `memory: "mmdata"`; verify the resolved node's instructions (plus referenced-node sections) are returned and a usage event is recorded — identical output to calling `h-run-action` with the node's full URN.

**Acceptance Scenarios**:

1. **Given** an accessible memory matching "mmdata" with one runnable node matching "add-review-node", **When** the user runs the task by those two hints, **Then** that node is executed and its assembled instructions are returned.
2. **Given** a task hint that uniquely matches one runnable node in the resolved memory, **When** resolution runs, **Then** the node is executed directly without a disambiguation step.
3. **Given** a fully-qualified `urn` is supplied instead of hints, **When** the tool runs, **Then** resolution is skipped and behavior is byte-identical to `h-run-action`.
4. **Given** template args are supplied, **When** the task runs, **Then** `{{key}}` placeholders in the node content are substituted before return (parity with `h-run-action`).

---

### User Story 2 - Pick from a menu when the hint is ambiguous or absent (Priority: P1)

When the user's hint matches more than one runnable node (or more than one memory), or when they give no hint at all ("run a task here"), the server presents an interactive **selection** and the user picks one. The picker shows each candidate's display name and description; the user's choice resolves to a node and the task runs. This is the "a skill would have shown me a list of choices" experience, delivered natively.

**Why this priority**: Disambiguation is not an error path — it is the primary UX for discovery. Hadron is a graph the user does not hold in their head; the menu is how they find what is runnable. Without it, the feature degrades back into URN-hunting whenever a hint is imperfect.

**Independent Test**: With a memory containing three runnable nodes, call the tool with no task hint; verify an elicitation request is issued enumerating the three (name + description), and that selecting one executes exactly that node. Repeat with a memory hint matching two memories; verify a memory pick precedes the task pick.

**Acceptance Scenarios**:

1. **Given** two memories matching the memory hint, **When** resolution runs, **Then** the user is asked to pick a memory before any task resolution proceeds.
2. **Given** a task hint matching several runnable nodes in the resolved memory, **When** resolution runs, **Then** the user is presented a single-select list of just those matches and the chosen node runs.
3. **Given** no task hint and a small runnable set in the resolved memory, **When** resolution runs, **Then** the user is presented the full runnable list to pick from.
4. **Given** an elicitation selection list, **When** the user declines or cancels, **Then** no task runs, the tool returns a plain "nothing selected" result, and no error envelope is emitted.
5. **Given** a memory pick has been made, **When** the task list is presented, **Then** it contains only runnable nodes from the picked memory.

---

### User Story 3 - Graceful fallback where elicitation is unsupported (Priority: P2)

In a client that does not implement MCP elicitation, the same request still works: the tool returns the candidate list as structured content, the agent presents it to the user as a numbered list, the user replies with a choice, and the agent re-invokes the tool with the selected URN. No capability means a slightly longer conversation — never a dead end.

**Why this priority**: The target audience runs Claude Code (which supports elicitation), but the platform serves many MCP clients. The feature must not hard-depend on a capability some clients lack, or it becomes unusable outside one surface.

**Independent Test**: Simulate a client that does not advertise the elicitation capability; issue an ambiguous request; verify the tool returns the candidate list (names, descriptions, URNs) as content rather than issuing an elicitation request, and that a follow-up call with a chosen URN executes that node.

**Acceptance Scenarios**:

1. **Given** a client without the elicitation capability, **When** an ambiguous request is made, **Then** the tool returns the candidates as a numbered, selectable list in its content (no elicitation request issued).
2. **Given** the returned candidate list, **When** the agent re-invokes the tool with one candidate's URN, **Then** that node executes.
3. **Given** a client WITH the elicitation capability, **When** an ambiguous request is made, **Then** the tool issues an elicitation request instead of returning a list for the model to relay.

---

### User Story 4 - Direct, unchanged execution by URN (Priority: P3)

A caller (or another tool, or automation) that already holds a fully-qualified URN continues to execute it directly, unchanged. The new name-resolution path is purely additive; the existing executor's contract and invariants are preserved.

**Why this priority**: Protects existing behavior and callers while the new entry point is introduced. Low priority because it is "do not break what exists," validated by reuse rather than new capability.

**Independent Test**: Call the existing `h-run-action` with a full URN before and after this feature ships; verify identical output, usage-event recording, and error behavior.

**Acceptance Scenarios**:

1. **Given** a fully-qualified URN, **When** executed via the direct path, **Then** output, dependency resolution, arg substitution, and usage recording are unchanged from today's `h-run-action`.
2. **Given** an App-scoped runnable node and a multi-App caller without an active App, **When** executed, **Then** the spec-026 `[no_active_app]` typed error applies exactly as it does for App-scoped `h-run-action` today.

---

### Edge Cases

- **No memory hint, with an active memory set**: resolve within the active memory; do not search elsewhere unless the task hint finds nothing there.
- **No memory hint, no active memory**: present a memory selection (or, with a strong unambiguous task hint, see scope-widening below).
- **Task hint misses in the resolved memory**: MAY broaden to other accessible memories and surface "found *N* matches in other memories" via selection; MUST NOT silently execute a task from a memory the user did not imply.
- **Runnable set too large for a usable picker** (beyond ~2 dozen): the tool MUST require or solicit a narrowing hint rather than emit an unusable list; the cap and behavior are stated, not silent.
- **Free-standing personal memories** (spec 034, excluded from `h-list-memories`): MUST remain reachable by explicit hint — candidates are sourced from the access layer, not the advisory listing.
- **Hint matches a node the caller cannot read**: the node is not a candidate and its existence is not revealed (access parity with `canReadMemory`).
- **Resolved node has no content**: treated as not runnable; excluded from candidates (or, if explicitly chosen, returns a clear "this node has no instructions to run" message).
- **Decline/cancel at the memory step**: stop; no task resolution, no run.
- **Exactly one memory matches but zero runnable nodes in it**: clear "no runnable tasks in *memory*" message, not an empty picker.
- **Soft-deleted nodes/memories** (`deletedAt`): never candidates.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an MCP tool that executes a runnable node identified by a **loose task name**, optionally scoped by a **loose memory name**, without requiring a fully-qualified URN.
- **FR-002**: The runnable candidate set MUST be the non-deleted nodes in the resolved memory that satisfy the **runnable predicate**. The predicate is `isRunnable = true` *(recommended; see Assumptions)* or `nodeType = 'task'` *(user's stated definition)* — pending the decision in Clarifications.
- **FR-003**: Memory resolution MUST draw candidates only from memories the caller can read (the access-control set computed by `getAccessibleMemoryIds` / `getMemoryAccess`), never the advisory listing alone, so access parity holds and free-standing personal memories remain reachable by explicit hint.
- **FR-004**: When a memory hint is supplied, the system MUST match it case-insensitively against memory name/slug/URN, ranking exact > prefix > substring. One match resolves; multiple trigger a memory selection; zero either widens or returns a clear "no memory matching *hint*."
- **FR-005**: When no memory hint is supplied, the system MUST resolve to the active memory if one is set; otherwise it MUST present a memory selection (subject to scope-widening, FR-010).
- **FR-006**: Within the resolved memory, when a task hint is supplied, the system MUST match it case-insensitively against node name/alias/description/loc. One match runs (FR-009); multiple trigger a task selection; zero either widens (FR-010) or returns a clear "no runnable task matching *hint*."
- **FR-007**: When no task hint is supplied, the system MUST present a selection over the resolved memory's runnable set (subject to the size cap, FR-011).
- **FR-008**: Disambiguation MUST be presented via MCP **elicitation** as a single-select choice when the client advertises the elicitation capability. Each option MUST show a human-readable label (node/memory display name) and description; the resolved value MUST be the fully-qualified URN.
- **FR-009**: When exactly one candidate matches an explicit hint, the system MUST execute it directly (no confirmation step) — *default; tunable per Assumptions*. Confirmation is reserved for ambiguity.
- **FR-010**: When a task hint finds nothing in the resolved (or active) memory, the system MAY broaden the search to other accessible memories and present the cross-memory matches as a selection; it MUST NOT execute a task from a memory other than the one implied without an explicit user selection.
- **FR-011**: When a candidate set exceeds an elicitation-friendly size (a stated cap of roughly two dozen), the system MUST solicit or require a narrowing hint rather than emit an unusable list. The cap MUST be explicit, never a silent truncation.
- **FR-012**: When the client does NOT advertise the elicitation capability, the system MUST return the candidate set as structured content (label, description, URN) for the agent to present, and MUST accept a follow-up invocation carrying a chosen URN. It MUST NOT issue an elicitation request to such clients.
- **FR-013**: An elicitation **decline** or **cancel** MUST result in no execution, a plain "nothing selected" result, and no typed-error envelope.
- **FR-014**: A fully-qualified `urn` input MUST bypass all resolution and execute directly, preserving the existing `h-run-action` contract (spec 022 full-qualified-URN requirement applies to this direct path).
- **FR-015**: Execution MUST reuse the existing `h-run-action` core: `{{key}}` argument substitution, edge-linked dependency resolution into a "Referenced Nodes" section, usage-event recording, and the assembled-instructions return shape. The shared logic MUST be factored so both tools call one implementation.
- **FR-016**: Access control MUST follow `canReadMemory` / the App-isolation gates: a node the caller cannot read is never a candidate and its existence is never disclosed through resolution, counts, or error text.
- **FR-017**: If a resolved runnable node (or its declared scope) is App-scoped, the spec-026 active-App requirement and `[no_active_app]` typed error MUST apply, consistent with App-scoped `h-run-action` today.
- **FR-018**: The target memory's configuration MUST be consulted on execution, consistent with spec 024 for write/run tools.
- **FR-019**: Hint matching in v1 MUST use keyword/substring semantics consistent with `h-find-nodes` (no stemming, no semantic match, body not indexed). The resolver MUST expose a clean seam — `(hint, candidates) → ranked matches` — so the matching strategy can be swapped for semantic ranking when a name/identifier vector index exists (see Assumptions), without changing the selection or execution flow.
- **FR-020**: A usage event MUST record the resolved node and that it was invoked via name-resolution (versus direct URN), for lineage and analytics.

### Key Entities

- **Node (runnable)** *(existing)*: A non-deleted node satisfying the runnable predicate (FR-002), carrying `content` (the instructions), `outgoingEdges` (dependencies resolved into "Referenced Nodes"), and the descriptive fields used for matching (`name`, `alias`, `description`, `loc`). Optional `properties`/`args` feed `{{key}}` substitution.
- **Memory** *(existing)*: The scope for a runnable set; candidates are constrained to the caller's accessible set (FR-003).
- **`h-run-task`** *(new MCP tool)*: The name-resolving entry point. Inputs: optional `task` hint, optional `memory` hint, optional fully-qualified `urn` (escape hatch), optional `args`. Delegates execution to the shared `h-run-action` core.
- **`h-run-action`** *(existing, unchanged)*: The direct-URN executor; retains its spec 022/024/026 invariants, docs, and contract. Source of the shared execution core.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can run a task by saying "run *X* in *Y*" with no URN; when *X* and *Y* uniquely identify a runnable node within the accessible set, the task executes with at most zero disambiguation steps in 100% of such cases.
- **SC-002**: Ambiguous or hint-less requests always terminate in a user selection (elicitation where supported, numbered-list relay otherwise) — never an error dead-end and never the execution of a node the user did not choose.
- **SC-003**: No candidate, count, or message ever references a node or memory the caller cannot read (verified by access-parity tests against `canReadMemory`).
- **SC-004**: Direct-URN execution is byte-identical to `h-run-action` before and after this feature (verified by reuse tests), and `h-run-action`'s spec 022/024/026 behaviors are unchanged.
- **SC-005**: The feature works end-to-end on Claude Code (CLI and the Claude-for-Mac "Code" tab) via elicitation, and degrades to the numbered-list relay on a client without the capability (both paths exercised).

## Assumptions

- **Runnable predicate (the one open decision).** The schema carries both `nodeType` (string, default `info`) and a purpose-built `isRunnable Boolean?` documented as *"If true, this node can be executed as a task."* Recommendation: use **`isRunnable = true`** as the predicate — it is the field whose stated purpose is exactly this question, it is `nodeType`-agnostic (an `action`- or `task`-typed node can be runnable), and it excludes `task`-typed nodes that are notes rather than procedures. A one-time backfill (`UPDATE node SET is_runnable = true WHERE node_type = 'task'`) aligns it with the user's stated `nodeType = 'task'` definition. If `isRunnable` is not yet populated anywhere, the user may prefer to start with `nodeType = 'task'` and adopt the flag later; the resolver predicate is a single point of change.
- **New tool, shared core — not a rename.** `h-run-action` is referenced by specs 022 (full-URN), 024 (memory-config), and 026 (App-scoped strict-tool `[no_active_app]`), by the docs (`mcp-tools.md`, `mcp-app-selection.md`), and by a (stale) `hadron-client` caller. Renaming or overloading it would ripple through those invariants. Instead, factor its load → substitute → resolve → return body into a shared helper and add `h-run-task` as the name-resolving entry that calls it. The +1 tool's always-on context cost is negligible given Claude Code defers tool schemas (Tool Search). Alternative considered: fold everything into one `h-run` and deprecate `h-run-action` — higher blast radius, deferred.
- **Matching is keyword/substring in v1**, matching `h-find-nodes` semantics (predictable, no surprises). The known imperfection — loose paraphrases miss — is absorbed by the selection menu (FR-007/FR-008) rather than by fuzzy guessing. A **name/identifier vector index** (semantic search over memory and node *names*, distinct from the spec-033 content/abstract index) is the planned upgrade that makes hint resolution semantic; it is out of scope here and tracked separately. FR-019's resolver seam is the integration point.
- **Memory candidate set** comes from `getAccessibleMemoryIds` / `getMemoryAccess` (`src/mcp/access-control.ts`), which unions across the caller's accessible Apps. App-Key callers receive no org-read (existing parity); free-standing personal memories (spec 034) are excluded from the advisory `h-list-memories` but remain reachable here because candidates are drawn from the access layer.
- **Elicitation is available**: the installed `@modelcontextprotocol/sdk@^1.27.1` exposes server-side `elicitInput` with single-select enum support; Claude Code (CLI and Code tab) renders it as an interactive selection. Capability is detected per client; absence triggers the FR-012 relay.
- **Auto-run on a unique explicit-hint match** (FR-009) is the default; a "confirm before run" mode is a tunable, not a v1 requirement.
- **Active memory / active App** are existing session concepts (`h-set-active-memory`, `h-set-active-app`); resolution honors them as hints, never as walls (consistent with spec 026's advisory-identity posture).
- **Out of scope (deferred)**: the name/identifier vector index itself (separate spec); multi-select or batch task execution; scheduling/headless invocation; retiring or renaming `h-run-action`; write-task semantics; cross-org URN references.
