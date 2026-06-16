# Feature Specification: Batch node read (multi-node content retrieval)

**Feature Branch**: `037-batch-node-read`
**Created**: 2026-06-16
**Status**: Draft
**Input**: User description: "Add a way to retrieve the full content of multiple nodes in one call — a bounded batch read, exposed as an MCP tool (`h-read-nodes`) and on the GraphQL surface, so agents / the CLI / RAG consumers can pull a set or a subtree of node bodies without N separate `h-read-node` calls. Also lets `spec lint --all` and similar bulk commands stop doing N+1 `GetNodeById` round-trips."

## Context

Today there is **no single call that returns full node content (+ edges) for more than one node**:

- `h-read-node` / GraphQL `node`/`nodeById` return one node (meta + abstract + content + edges).
- `h-list-nodes` returns tree **structure only**; the GraphQL `nodes(...)` list returns **shallow** fields (no `content`, no edges); `h-find-nodes` returns ranked matches (with `expand` for neighbours and `granularity: chunk` for passages) but not the full body of an arbitrary set.

So every "read many bodies" workflow is **N+1**: list, then one read per node. `hadron spec lint --all` is the concrete sufferer — it issues one `nodes` query then a `GetNodeById` per node (≈112 round-trips on `hadronmemory.com::platform-specs`). Migration, audit, review, and RAG context-stuffing have the same shape.

This was surfaced during the platform-specs loc-as-citation migration (which leaned on many parallel `h-read-node` calls as a workaround). Related CLI bugs from that work: hadron-cli#21, hadron-cli#23 — #23 (silent ~100-row truncation) is the cautionary tale behind the hard-cap requirement below.

A client-side `hadron spec get --prefix` (fan-out over existing reads) ships separately as an immediate convenience; this spec is the durable server-side primitive both it and `lint` should eventually sit on.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Read an explicit set of nodes in one call (Priority: P1)

An agent (via MCP) or the CLI holds a list of node URNs and wants each node's full content + edges in a single round-trip, instead of one call per node.

**Independent Test**: Request 10 known URNs (some in different memories the caller can read); verify one call returns all 10 with content + edges, in a caller-meaningful order.

**Acceptance Scenarios**:
1. **Given** N (≤ cap) readable node URNs, **When** the caller batch-reads them, **Then** all N are returned with the same per-node projection as `h-read-node`.
2. **Given** a mix of readable and unauthorized/non-existent URNs, **When** the caller batch-reads, **Then** the readable subset is returned **and** the denied/not-found URNs are reported in a separate list — the call does **not** fail wholesale.

### User Story 2 — Read a subtree/prefix with content (Priority: P2)

A reviewer/migrator wants every node under a loc-prefix (one feature, one module) with bodies, in one call.

**Independent Test**: Batch-read prefix `cor:cht` on platform-specs; verify all nodes under it return with content, bounded by the cap.

### User Story 3 — Cheap abstract-only batch for RAG/triage (Priority: P2)

A caller wants only abstracts for a set/subtree (to context-stuff or triage) without paying for full bodies.

**Independent Test**: Batch-read with `contentScope: abstract`; verify abstracts returned, bodies omitted.

### User Story 4 — Bulk CLI commands drop N+1 (Priority: P2)

`spec lint --all` (and future content-needing bulk commands) fetch node detail via the batch read instead of per-node `GetNodeById`.

**Independent Test**: Run `spec lint --all` against a 112-node corpus; verify it issues a small constant number of server calls (not ~N), with identical findings.

## Requirements *(mandatory)*

- **FR-001** Provide a batch read keyed by an explicit list of node references (fully-qualified URNs; ID-shape accepted per the usual shape-detection), returning the full `h-read-node` projection per node (meta, abstract, content, outgoing + incoming edges).
- **FR-002** Provide a subtree/prefix variant (memory + loc-prefix). Decide whether this is the same endpoint (URN-list **or** prefix input) or a sibling — but both must exist.
- **FR-003** Honor `contentScope` (`content` | `abstract` | `all`, from spec 031) per call, so callers can pull abstract-only cheaply.
- **FR-004 (hard caps — load-bearing)** Enforce a max node count per call **and** a max total response size. Exceeding a cap MUST be **loud** — a typed error or an explicit `truncated: true` + returned-count, never a silent short read. (Direct lesson from hadron-cli#23.)
- **FR-005 (per-node authorization)** Apply the existing per-node read gate (`canReadMemory` / `getAccessibleMemoryIds`) to **each** node independently; return only authorized nodes plus a separate list of denied/not-found refs. A single denial never fails the batch. Mixed-memory batches are allowed, each endpoint gated on its own memory. (Preserves the BOLA posture; no widening past per-node access.)
- **FR-006 (usage events — decision required)** Define the `UsageEvent` policy for a batch read: one `read` event per returned node (preserves per-node accounting/billing) **or** one batch event. Recommend per-node for parity with `h-read-node`; confirm with billing.
- **FR-007 (encryption)** Respect memory encryption exactly as `h-read-node` does; the MCP read path's existing non-decrypt gap (#206) applies equally — do not introduce a new ciphertext-leak or a divergent decrypt path.
- **FR-008 (surfaces)** MCP: `h-read-nodes` (array of fully-qualified URNs; optional `contentScope`; optional prefix form per FR-002). GraphQL: extend `nodes(...)` with an opt-in content/edges projection, or add `nodesByIds` / `nodesByLocs`. Keep the response DTO stable and shared with the single-node read.
- **FR-009 (ordering)** Stable, caller-meaningful order: input order for an explicit list; loc order for a prefix.
- **FR-010 (consume it)** Refactor `hadron spec lint --all` (and the per-node detail loop in `register`/`describe` if it grows one) onto the batch read to eliminate N+1.

## Success Criteria *(mandatory)*

- One call returns up to the cap of node bodies with the `h-read-node` projection.
- `spec lint --all` issues a small constant number of server calls regardless of corpus size, with byte-identical findings to today.
- Over-cap requests are loud (error or explicit truncation flag); unauthorized/missing refs are reported, not fatal.
- No new plaintext exposure for encrypted memories beyond today's single-node behavior.

## Assumptions

- Builds on spec 031 (`abstract` + `contentScope`) and the existing `canReadMemory` / `getAccessibleMemoryIds` gates.
- The single-node `h-read-node` projection is the per-node shape; batch reuses it.

## Out of Scope

- Vector / semantic retrieval and passage chunking — that is spec 033 (`h-find-nodes mode: vector` / `granularity: chunk`); batch read is for known sets/subtrees, not relevance ranking.
- Cursor pagination — caps + prefix scoping are judged sufficient for v1; revisit if a real >cap subtree dump is needed.
- Cross-memory transactional/consistency guarantees across the batch (it is a read).
- Writes / batch mutation.

## Dependencies

- Spec 031 (abstract, `contentScope`); overlap check against spec 033 (so RAG context-stuffing isn't built twice — confirm whether `find` chunk/expand already covers the relevance path, leaving batch-read for explicit sets + `lint`).
- #206 (MCP read-path decrypt parity) — same caveat applies.
- `hadron-cli` consumes it: `spec lint --all` (FR-010) and, optionally, re-point `spec get --prefix` from its client-side fan-out onto `h-read-nodes`.

## Open Questions

1. Usage-event policy: per-node vs single batch event (FR-006) — billing call.
2. One endpoint accepting URN-list **or** prefix, vs two endpoints (FR-002/FR-008).
3. Does spec 033's `h-find-nodes` (`expand`, `granularity: chunk`) already cover enough of the RAG case that batch-read can scope to explicit sets + `lint` only?
