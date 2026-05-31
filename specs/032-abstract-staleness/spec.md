---
target-repositories:
  - hadron-server
---

# Feature Specification: Node `abstractOriginHash` — stale-abstract detection

- **Feature Branch**: `199-abstract-staleness` *(numbering note: the speckit feature-branch script picked `199` because branch `198-ensure-agent-subscription-race` exists from the SC-006 fix; the spec directory uses the canonical sequential number `032` because only `031-node-abstract-field` exists in `specs/`. Branch and dir intentionally diverge — see Assumptions.)*
- **Created**: 2026-05-31
- **Status**: Draft
- **Input**: User description: "Add Node.abstractOriginHash field — stores the hash of the content the abstract was derived from, enabling stale-abstract detection. When `content` is updated without a corresponding `abstract` refresh, the staleness signal (abstractOriginHash != current contentHash) lets read tools mark the preview as stale, lets the validator flag it, and lets the upcoming RAG/vector layer skip or re-queue stale abstracts rather than embedding misleading summaries. Sequenced as a precursor to the RAG follow-up spec — vectorizing stale abstracts is a confidently misleading failure mode that staleness detection prevents."

## Background

Spec 031 (merged 2026-05-30) added `Node.abstract` — a paragraph-length summary of `content`, authored independently (no auto-derivation). The two columns are intentionally separate to give authors control over the summary text. The trade-off: nothing prevents the abstract from going **stale** when content is updated without a corresponding abstract refresh.

Today every consumer that surfaces the abstract — `h-find-nodes` previews, `h-read-node` (via `contentScope`), `h-validate`, and the upcoming RAG / vector-retrieval layer — treats the abstract as authoritative. A reader has no way to distinguish a fresh abstract that accurately summarises current content from a stale abstract that summarises a long-since-edited prior version.

This is acutely dangerous for the **RAG follow-up**: vectorising a stale abstract embeds a confident-but-wrong summary that semantic search will surface as authoritative. The reader trusts the embedding distance metric; they don't know the embedded text no longer matches the node's actual content. Without staleness detection, the RAG layer would amplify the failure mode every time a node's content is edited without its abstract being refreshed.

This spec adds `Node.abstractOriginHash` — a stored hash of the content the abstract was derived from. The hash is maintained automatically on every write surface. Consumers read it alongside `Node.contentHash` and treat divergence as a staleness signal: the abstract may no longer reflect what the content says.

The design is deliberately **passive**: the system observes and reports staleness; it does NOT automatically rewrite or invalidate the abstract. The author (human or agent) remains responsible for refreshing stale abstracts. The follow-up RAG spec will encode the "skip or re-queue" policy on top of the signal this spec exposes.

## User Scenarios & Testing

### User Story 1 — Write paths maintain `abstractOriginHash` correctly so the staleness signal is reliable (Priority: P1)

Every write surface that mutates `abstract` or `content` (MCP `h-add-node` / `h-update-node`, GraphQL `upsertNode`, importer round-trip, version restore) MUST keep `abstractOriginHash` in sync with the intent of the write. Specifically:

- When an author **writes a fresh abstract together with content** (or refreshes the abstract after a content edit), `abstractOriginHash` is set to the hash of the current content. The abstract is fresh; the signal will read "matches" until either side changes.
- When an author **updates only the content** (no abstract update in the same write), `abstractOriginHash` is left untouched. The stored hash now diverges from the new `contentHash`; the signal will read "stale" on the next read.
- When an author **updates only the abstract** (no content change), `abstractOriginHash` is reset to the hash of the current content. The author is explicitly affirming "this abstract matches current content as of this write."
- When the abstract is cleared (`abstract: null`), `abstractOriginHash` is also cleared. No abstract means no staleness signal.

Without US1, US2 and US3 cannot trust the signal: a stale "fresh" reading or a fresh "stale" reading is worse than no signal at all.

**Why this priority**: This is the foundational invariant. Every other story rides on it. Implemented alone, the column is observable (queryable via GraphQL, inspectable in the DB) and the contract is testable — even before any consumer surfaces the staleness signal to users.

**Independent Test**: A test seeds a node with abstract + content, asserts `abstractOriginHash == hash(content)`. Updates only content; asserts `abstractOriginHash` is unchanged (now stale). Refreshes the abstract via `h-update-node`; asserts `abstractOriginHash == hash(new content)`. Clears the abstract; asserts `abstractOriginHash` is null.

**Acceptance Scenarios**:

1. **Given** an existing memory, **When** an agent calls `h-add-node` with both `abstract` and `content`, **Then** `Node.abstractOriginHash` is set to `hash(content)` and `Node.contentHash` is also set to `hash(content)`.
2. **Given** a node with `abstract: "X"`, `content: "Y"`, `abstractOriginHash: hash("Y")`, **When** an agent calls `h-update-node` with `content: "Y'"` (no abstract field), **Then** `abstractOriginHash` is unchanged (still `hash("Y")`), `contentHash` is updated to `hash("Y'")`, and the two diverge — the staleness signal is now armed.
3. **Given** a node where `abstractOriginHash` and `contentHash` have diverged (stale), **When** an agent calls `h-update-node` with `abstract: "X'"` (no content field), **Then** `abstractOriginHash` is reset to `hash(current content)` — the author has affirmed the new abstract matches current content.
4. **Given** a node with `abstract: "X"` and a populated `abstractOriginHash`, **When** an agent calls `h-update-node` with `abstract: null` (clearing), **Then** `abstractOriginHash` is also cleared to `null`.
5. **Given** a write to a node where `content` is `null` and `abstract: "X"` is set (the FR-005 fallback case from spec 031), **When** the write completes, **Then** `abstractOriginHash` is `null` (no content to hash; the staleness check naturally short-circuits).
6. **Given** the GraphQL `upsertNode` mutation, **When** the same input shapes from acceptance scenarios 1–5 above are sent, **Then** the resulting `Node.abstractOriginHash` matches the MCP-path expectations byte-for-byte.
7. **Given** the node.yaml importer, **When** a YAML file with both `abstract:` and content body is imported, **Then** `abstractOriginHash` is computed from the imported content (importer treats the YAML as a fresh authored write; round-trip integrity is preserved across export → import).
8. **Given** a `restoreNodeVersion` call, **When** a prior version with both `abstract` and `abstractOriginHash` is restored, **Then** the restored node's `abstractOriginHash` matches the version's stored value (version history captures the hash alongside the abstract).

---

### User Story 2 — `h-read-node` surfaces a `Source: abstract-stale` marker when the abstract is stale (Priority: P2)

When `h-read-node` is called and the node is stale (`abstract IS NOT NULL` AND `content IS NOT NULL` AND `abstractOriginHash != contentHash`), the meta block carries a `Source: abstract-stale` line. The marker is symmetric in shape to spec 031's `Source: abstract-fallback` marker (same position in the meta block, same parse-friendly format) so a single regex or string check covers both signals.

The marker MUST appear under any `contentScope` value that surfaces the abstract — that is, `'abstract'` and `'all'`. Under `contentScope: 'content'` (default), the abstract is not in the response, so the marker is irrelevant and MUST NOT appear (no need to alarm callers about content they aren't reading). The content-fallback case from spec 031 (default scope + content-less node + abstract-having → abstract substituted into body slot) is distinct: there's no content to be stale against, so the `Source: abstract-fallback` marker fires but `Source: abstract-stale` does not.

**Why this priority**: This is the primary user-facing surfacing. An agent reading a node sees the marker and can decide to read the body anyway, refresh the abstract, or treat the abstract with appropriate skepticism. Without US2, the staleness signal exists but only programmatic consumers (RAG layer, future linters) can see it.

**Independent Test**: Seed a node with abstract + content, hashes matching. Read with `contentScope: 'all'`; assert NO `Source: abstract-stale` line. Update only content. Read with `contentScope: 'all'`; assert `Source: abstract-stale` line is present in the meta block. Refresh the abstract. Read again; assert the marker is gone.

**Acceptance Scenarios**:

1. **Given** a fresh node (`abstractOriginHash == contentHash`, both non-null), **When** `h-read-node` is invoked with `contentScope: 'all'`, **Then** the response is meta block + abstract + `---` + body, with NO `Source: abstract-stale` line in the meta block.
2. **Given** a stale node (`abstractOriginHash != contentHash`, both non-null), **When** `h-read-node` is invoked with `contentScope: 'all'`, **Then** the meta block contains a `Source: abstract-stale` line (positioned consistently with `Source: abstract-fallback` from spec 031 FR-005) and the abstract + content render normally.
3. **Given** a stale node, **When** `h-read-node` is invoked with `contentScope: 'abstract'`, **Then** the meta block contains the `Source: abstract-stale` line and the abstract is returned (no body).
4. **Given** a stale node, **When** `h-read-node` is invoked with `contentScope: 'content'` (default), **Then** the response is byte-identical to a fresh-node default-scope read — NO `Source: abstract-stale` line. The marker only fires when the abstract is actually in the response.
5. **Given** a content-less abstract-having node (the spec 031 FR-005 fallback case), **When** `h-read-node` is invoked with default `contentScope`, **Then** the meta block contains `Source: abstract-fallback` but NOT `Source: abstract-stale` — there's no content to be stale against.
6. **Given** a node with both `Source: abstract-stale` AND `Source: abstract-fallback` would theoretically apply (a node whose content was once set and is now null but abstract remains): this case is **excluded by FR-007** — when content goes to null, `abstractOriginHash` is left as-is, but the staleness check requires content to be non-null, so the stale marker does not fire. Only the fallback marker applies.

---

### User Story 3 — `h-validate` flags stale abstracts as a warning (Priority: P3)

`h-validate`'s existing per-node checks (broken edges, sparse nodes) gain a third check: stale abstracts. When a node satisfies the staleness condition (per US2), the validator reports `[stale-abstract] <urn> — abstract may not reflect current content`. The check is a **warning**, not a hard failure — staleness is a quality signal, not an invariant violation. The validator's existing "Found N issue(s) in M nodes" envelope counts stale-abstract warnings alongside other issues.

**Why this priority**: Bulk-detection across a memory. A human or agent running `h-validate` periodically (or as part of pre-commit / CI gates) gets a list of stale abstracts to refresh. Useful but not on the critical path for the RAG follow-up (which reads `abstractOriginHash` directly, not via `h-validate`).

**Independent Test**: Seed a memory with three nodes: one fresh-abstract, one stale-abstract, one no-abstract. Run `h-validate`. Assert the stale node appears in the issue list with the `[stale-abstract]` tag; the other two do not.

**Acceptance Scenarios**:

1. **Given** a memory containing a stale node, **When** `h-validate` is invoked, **Then** the report includes a line `[stale-abstract] <urn> — abstract may not reflect current content`.
2. **Given** a memory containing only fresh-abstract or no-abstract nodes, **When** `h-validate` is invoked, **Then** no `[stale-abstract]` lines appear.
3. **Given** a memory containing a mix of stale, fresh, and sparse nodes, **When** `h-validate` is invoked, **Then** the issue count reflects the sum across all three rule types; each issue type uses its own tag (`[stale-abstract]`, `[sparse]`, `[broken-ref]`).

---

### Edge Cases

- **No abstract, any content**: `abstractOriginHash` is `null`. Staleness check short-circuits (one side is null → not stale). No marker, no warning.
- **Abstract set, content null** (FR-005 fallback case): `abstractOriginHash` is `null`. Staleness check short-circuits. `Source: abstract-fallback` may fire on read; `Source: abstract-stale` does not.
- **Both null** (sparse node): all hashes are null. No staleness signal. The sparse-node check from spec 031 FR-011 handles this case independently.
- **Content updated to null after abstract was authored**: per FR-007, `abstractOriginHash` is left untouched on a content-only write. So the stored hash persists. But the staleness check requires `content IS NOT NULL` to fire — so the marker does not appear. The result: a "ghost" hash sits in the DB. Cosmetic; no consumer surfaces it. Could be cleaned up by a future spec, not in scope here.
- **Hash collision** (two different content values yielding the same hash): theoretically possible with truncated SHA256. Treats them as equal → no staleness signal even though the content semantically differs. Acceptable risk at the hash truncation width used by `contentHash` (`Node.contentHash` already accepts this risk for change-detection).
- **`abstract` is set to an empty / whitespace-only string** (per spec 031 FR-009, this normalises to `null`): `abstractOriginHash` is cleared along with `abstract` per FR-006. No staleness signal.
- **Restore an older version where `abstractOriginHash` is null but the version's content + abstract are both non-null** (e.g., a version snapshotted *before* this spec ships, then restored *after*): the restored node has stale-looking state — both columns populated, but `abstractOriginHash` is `null`. The staleness check short-circuits (one side null → not stale), so no false positive. To get a meaningful staleness signal on legacy versions, the implementation has the option of recomputing `abstractOriginHash` from the restored `content` at restore time. **Documented as a Question for the planning phase** rather than fixed here.

## Requirements

### Functional Requirements

- **FR-001**: `Node` MUST gain an optional `abstractOriginHash` text column. Existing rows backfill to `NULL`. The column is additive — no existing column changes shape or semantics.
- **FR-002**: `NodeVersion` MUST gain a matching optional `abstractOriginHash` column so version-history snapshots capture the hash alongside the abstract (per the spec 031 lesson learned: NodeVersion is a curated subset; new Node columns require matching NodeVersion additions or restore silently drops them).
- **FR-003**: On any write surface that sets or replaces `abstract` to a non-null value (`h-add-node`, `h-update-node`, GraphQL `upsertNode`, importer), the system MUST set `abstractOriginHash` to `hash(current content)`. If `content` is null/empty at write time, `abstractOriginHash` MUST be set to `null`.
- **FR-004**: On a write that updates ONLY `content` (no `abstract` key in the payload), the system MUST leave `abstractOriginHash` untouched. The stored hash will diverge from the new `contentHash`, producing the staleness signal on the next read.
- **FR-005**: On a write that updates BOTH `abstract` and `content` together, the system MUST set `abstractOriginHash` to `hash(new content)`. The author is affirming both writes match.
- **FR-006**: On a write that clears `abstract` (`abstract: null`), the system MUST also clear `abstractOriginHash` to `null`. No abstract means no staleness signal to maintain.
- **FR-007**: On a write that clears `content` (`content: null`) without an abstract update, the system MUST leave `abstractOriginHash` untouched. The staleness check downstream requires `content IS NOT NULL` to fire, so the "ghost" hash does not produce false positives. (This is the deliberate edge-case handling for the abstract-only-archive case.)
- **FR-008**: The hash algorithm used for `abstractOriginHash` MUST be the same algorithm used for `Node.contentHash`. Specifically: a deterministic, content-only hash (the existing `contentHash` machinery; SHA256[0:N] per the existing schema doc). The two hashes MUST be comparable byte-for-byte so the staleness check is a simple string equality.
- **FR-009**: The hash MUST be computed over the **plaintext** content, not the encrypted ciphertext. On encrypted memories, the encryption layer MUST receive the plaintext content, compute the hash, store the hash plaintext (the hash itself is not sensitive — it's an 8-character fingerprint, not the content), then encrypt the content for storage. This guarantees that `abstractOriginHash` is meaningful across encrypted memories (otherwise the hash would change every time content is re-encrypted with a new nonce, defeating change detection).
- **FR-010**: `h-read-node` MUST emit a `Source: abstract-stale` line in the meta block when ALL of the following are true: (a) `abstract IS NOT NULL`, (b) `content IS NOT NULL`, (c) `abstractOriginHash != contentHash`, AND (d) the response includes the abstract (`contentScope` is `'abstract'` or `'all'`). The marker MUST be positioned consistently with the existing `Source: abstract-fallback` marker (same meta-block slot, same prefix format). The marker MUST NOT appear under `contentScope: 'content'` (the abstract isn't in the response; the marker would alarm without reason).
- **FR-011**: `h-validate` MUST flag stale abstracts as a warning. Issue format: `[stale-abstract] <urn> — abstract may not reflect current content`. Stale-abstract warnings MUST be counted in the existing issue total alongside sparse-node and broken-edge warnings; the consumer-facing report shape is unchanged (one issue list, one summary count).
- **FR-012**: GraphQL `Node` type MUST expose `abstractOriginHash: String` as a read-only field. The field MUST NOT appear on `NodeInput` — `abstractOriginHash` is system-managed, never settable by a caller. (Allowing caller-supplied values would defeat the staleness invariant: a malicious or buggy caller could write a fresh-looking hash that doesn't match the content.)
- **FR-013**: The node.yaml importer MUST treat YAML files without an `abstractOriginHash:` frontmatter key as a fresh authored write (compute `abstractOriginHash` from the imported content at parse time). When the YAML carries an `abstractOriginHash:` key, the importer MUST trust the value (don't recompute) — this preserves staleness state across export → import round-trips. The exporter MUST write `abstractOriginHash:` to the frontmatter when the column is non-null (omit when null, parallel to the spec 031 importer/exporter omit-on-null convention).

### Entity Impact

**Modified**:

- **Node** (`prisma/schema.prisma`) — adds an optional text column `abstractOriginHash` positioned adjacent to the existing `contentHash` field in the model layout. Nullable; no default; no CHECK constraint. Same column width / type as `contentHash`. Existing rows backfill to `NULL` (no staleness signal on pre-spec nodes — they were authored before the invariant existed; treating them as "always fresh" is the right migration default).
- **NodeVersion** (`prisma/schema.prisma`) — adds the matching optional text column `abstractOriginHash` so audit snapshots and `restoreNodeVersion` round-trip the hash alongside the abstract. Same lesson learned as spec 031's FR-013 / Entity Impact note — NodeVersion is a curated subset, not auto-projected. The migration MUST add the column AND every `nodeVersion.create` call site MUST include it AND `restoreNodeVersion`'s write payload MUST include it.

**Source of truth**: `hadron-server/prisma/schema.prisma` (Prisma schema + migration tracked in tasks.md).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Write-path round-trip invariant holds. An integration test seeds a node through every write surface (`h-add-node`, `h-update-node`, GraphQL `upsertNode`, importer) and asserts `abstractOriginHash` matches `hash(content)` after every fresh write — across at least 5 distinct seed scenarios covering the FR-003 through FR-007 cases.
- **SC-002**: Staleness signal is observable by readers. After a content-only update, the next `h-read-node` with `contentScope: 'all'` returns a response containing `Source: abstract-stale` in the meta block. Refreshing the abstract clears the marker on the subsequent read. Demonstrated by a regression test.
- **SC-003**: `h-validate` reports stale-abstract warnings accurately. A seeded memory containing N stale, M fresh, and K abstract-less nodes produces exactly N `[stale-abstract]` warnings in the validator's report and zero false positives. Demonstrated by a regression test.
- **SC-004**: Zero behaviour change for any pre-spec node (which by definition has `abstractOriginHash IS NULL`). The staleness check short-circuits when either side of the comparison is null, so the marker does NOT appear on legacy nodes. Verified by snapshot tests on representative pre-spec fixtures.
- **SC-005**: GraphQL exposure is read-only. A mutation attempt to write `abstractOriginHash` via `NodeInput` MUST fail at the schema layer (the field doesn't exist on the input type) — verified by a GraphQL contract test asserting the field is absent from `NodeInput`.
- **SC-006**: Importer round-trip preserves staleness. A node exported with a stale `abstractOriginHash` (hash differs from content), re-imported via YAML round-trip, has the same `abstractOriginHash` as before — the importer trusts the YAML value over recomputing. Verified by a round-trip integration test.

## Assumptions

- **Hash algorithm is the existing `contentHash` machinery.** No new crypto primitives; reuse the SHA256-truncated approach already in use on `Node.contentHash`. Trade-off: theoretical hash collisions could mask staleness, but at the truncation width currently used the risk is acceptable (and parallel to the existing `contentHash` change-detection use case).
- **Branch number `199` vs spec directory number `032` divergence is acceptable.** The speckit feature-branch script picked `199` because of an unrelated `198-ensure-agent-subscription-race` branch. The canonical spec-directory sequence (`specs/NNN-name/`) continues with `032`. Future readers should treat the spec-dir number as authoritative; the branch number is a build artefact.
- **Passive observation, not active correction.** The system observes staleness and reports it; it does NOT automatically rewrite or invalidate the abstract. The author (human or agent) remains responsible for refreshing stale abstracts. A future spec could add an automated "refresh stale abstracts" surface, but it's out of scope here.
- **Encryption interaction follows spec 031's lesson.** The hash is computed over plaintext content BEFORE the encryption envelope is applied. The hash itself is non-sensitive (8-char fingerprint, not the content) and stored plaintext in `Node.abstractOriginHash` regardless of `Memory.isEncrypted`. Documented explicitly in FR-009 because the existing encryption surface in `src/lib/nodeCrypto.ts` only knows about content/data/abstract — hash maintenance is a resolver-level concern, not an encryption-layer concern.
- **`h-find-nodes` preview annotation is out of scope.** Adding a stale-abstract annotation to find-nodes previews would add visual noise to the survey/triage surface (callers are already triaging; adding a "this might be wrong" annotation per hit competes for attention with the actual hit content). A follow-up spec could add it if the RAG layer's behaviour proves to need a preview-level signal. For now, US2's `h-read-node` marker is the only end-user surface for the signal; US3's `h-validate` is the bulk surface; the RAG follow-up consumes the column directly.
- **`abstractOriginHash` is system-managed only.** The GraphQL surface exposes it read-only; MCP write surfaces don't accept it as an input parameter. Callers cannot supply a hash directly. Trade-off: a future migration tool that needs to bulk-fix stale hashes would need a separate (privileged) administrative path. Out of scope for v1.
- **Backfill on existing nodes is intentionally absent.** Existing nodes have `abstractOriginHash IS NULL` and produce no staleness signal. The "always fresh" default is correct for pre-spec content: those abstracts were authored before the invariant existed, so we have no truthful hash to attribute. Operators wanting to bulk-mark pre-spec nodes as "needs review" can run a one-off SQL update (assigning the current `contentHash` to `abstractOriginHash` would mark all existing abstracts as freshly authored — which is also defensible). Either policy is fine; the default is no signal.
- **Target repository is `hadron-server` only.** Schema, MCP tools, GraphQL surface, importer/exporter, validator. Portal-side UI rendering of the staleness signal is a follow-up if it requires non-trivial UX work; once the API returns the marker / signal, portal rendering is a localized component change.
