# Phase 0 — Research: Node `abstractOriginHash`

Design decisions made during planning, with rationale and alternatives. The spec resolved most axes during `/speckit-specify`; this file consolidates and adds the few Phase-0 decisions that emerged from looking at the actual code surfaces.

**Reading note**: same convention as spec 031 — references to existing code use symbolic anchors (function name, tool-registration block, named conditional) rather than line numbers so the docs don't rot. Sketches are illustrative, not load-bearing.

## D1 — Hash algorithm + width

**Decision**: SHA-256, hex-encoded, **first 8 characters** (32 bits of fingerprint). Matches the existing `Node.contentHash` convention documented in `prisma/schema.prisma` ("SHA256(yaml+md)[0:8]"). Reuse the same width so the two columns are directly comparable as strings.

**Rationale**: at the row counts this database handles (memories with at most ~tens of thousands of nodes per memory), an 8-hex-char (32-bit) fingerprint is plenty for change detection. Collision risk: `1/2^32` per pair, dominated by content-update cadence — orders of magnitude below the noise floor of "user updated content but forgot to refresh abstract." Bumping to 16 or 32 hex chars would be belt-and-suspenders without measurable benefit.

**Alternatives considered**:
- Full SHA-256 (64 hex chars): over-storing for the use case; the existing `contentHash` precedent dominates.
- Murmur3 / xxHash (faster non-cryptographic hashes): the existing helper-or-pattern is SHA-256; introducing a second algorithm is more surface for no win here. Speed is not a constraint.
- Hash over `name + content` rather than just `content`: name changes don't invalidate the abstract (the abstract summarises content, not name). Just `content`.

## D2 — Where the hash gets computed (write path)

**Decision**: at the **resolver layer / MCP tool handler layer**, BEFORE any encryption envelope is applied. The hash is computed on the **plaintext content** the caller supplied, then stored plaintext in `abstractOriginHash` (the hash itself is non-sensitive — it's an 8-char fingerprint, not the content). After the hash is computed, the existing encryption path runs (encrypts content/data/abstract per spec 031 FR-013, leaves the hash columns plaintext).

**Rationale**: any other ordering corrupts the staleness invariant.
- Hashing AFTER encryption would yield a different hash every time the same content is re-encrypted (encryption uses fresh nonces), defeating change detection entirely.
- Hashing in the database layer (Prisma middleware, Postgres trigger) would run AFTER encryption, breaking it the same way.

**Alternatives considered**:
- DB trigger on `nodes` table: runs after encryption; defeats invariant.
- Compute lazily on read (no stored column): forces every read on encrypted memories to decrypt first; turns a cheap O(1) column compare into an O(content length) operation per read. Storage is cheap; computation isn't free.

## D3 — Centralizing the hash helper

**Decision**: factor the hash computation into a small shared helper at `src/lib/contentHash.ts`:

```typescript
import { createHash } from 'crypto';

/**
 * Compute the canonical content fingerprint used by `Node.contentHash` and
 * `Node.abstractOriginHash`. SHA-256 truncated to the first 8 hex chars.
 * See spec 031 (Node.abstract) + spec 032 (abstractOriginHash) for the
 * staleness-detection contract that consumes the comparison.
 */
export function computeContentHash(content: string | null | undefined): string | null {
  if (content == null || content === '') return null;
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}
```

**Why a helper now**: the value gets computed in at least 4 sites (`h-add-node`, `h-update-node`, GraphQL `upsertNode`, importer). Spec 031 left three parallel normalizer implementations as a known follow-up — that's the exact failure mode this helper prevents from day one.

**Rationale**: one definition of "the hash" means the staleness check is byte-for-byte consistent across every write surface. Tests can assert against a known fixture value without re-implementing the hash logic per surface.

**Alternatives considered**:
- Inline the `createHash(...)` call at each site: faster to read at each site but adds drift surface. Spec 031's normalizer triad is the cautionary tale.
- Reuse an existing helper if one exists: the grep (research preamble) found no shared content-hash helper today; `contentHash` is currently set externally (YAML frontmatter, sync from Git). Creating the helper now also covers any future use of `Node.contentHash` server-side.

## D4 — Restore-version semantics for legacy versions (spec Q1)

**Decision**: `restoreNodeVersion` writes `version.abstractOriginHash` to the live node verbatim. If the version row pre-dates this spec, that value is `null`, and the live row ends up with `abstractOriginHash IS NULL`. **No recomputation.**

**Rationale**:
- The staleness check (`abstract != null AND content != null AND abstractOriginHash != contentHash`) naturally short-circuits when `abstractOriginHash IS NULL`. No false-positive stale signal on restored legacy versions.
- Restoring is supposed to be "byte-identical to the version" for every other column. Recomputing one column at restore time would be asymmetric and surprising — readers would not expect "I restored an old version, but one column is freshly computed."
- Operators who want a meaningful staleness signal on restored legacy content can call `h-update-node` with the existing abstract (no-op rewrite); the write-path machinery will populate `abstractOriginHash` correctly. Explicit, controlled, attributable.

**Alternatives considered**:
- Recompute `abstractOriginHash` from restored content when the version's hash is null: surprising restore semantics; could be a follow-up if operators ask for it; the no-op-rewrite workaround above covers the use case meanwhile.
- Refuse restores from legacy versions: heavy hammer; legacy versions are already in production; users would lose history access.

## D5 — `h-validate` stale-abstract gating (spec Q2)

**Decision**: no flag in v1. The stale-abstract check is always on. It naturally stays quiet on legacy abstracts (where `abstractOriginHash IS NULL`) because the staleness condition short-circuits.

**Rationale**: the question presumes "many legacy abstracts will trigger noisy warnings." They won't — legacy abstracts have null hash by definition. Only POST-spec abstracts (where the hash got populated by a write-path that ran AFTER this spec ships) will produce stale warnings. So on a memory dominated by pre-spec content, the validator stays quiet without any flag.

If a memory accumulates many post-spec abstracts and most of them go stale (e.g., a high-edit workflow where content updates outpace abstract refreshes), the warnings will be noisy. In that case, add the flag as a follow-up — but solving the noise problem in v1 is premature without evidence the problem exists.

**Alternatives considered**:
- Add `includeStaleAbstracts: bool` (default true): supports opt-out but adds a parameter agents have to discover. Defer.
- Add `severity: warning | error | off` (default warning): general-purpose surface area for all `h-validate` checks; out of scope here.

## D6 — `Source: abstract-stale` marker placement

**Decision**: the marker emits in the **same meta-block slot** as spec 031's `Source: abstract-fallback` — immediately after the `Type:` line, before `Tags:` / `Seq:` / etc. Fixed position so snapshot tests don't have to handle order variance; symmetric with the existing fallback marker so a single regex (`/^Source: (abstract-fallback|abstract-stale)$/m`) covers both signals for consumers that care.

**Rationale**: visual + structural consistency. Two `Source:` markers in adjacent slots, both describing "something about how this response was assembled."

**Co-occurrence**: per spec FR-010 + Edge Case for h-read-node, the two markers are mutually exclusive in practice — `abstract-fallback` requires `content IS NULL`, `abstract-stale` requires `content IS NOT NULL`. The implementation can emit at most one of the two `Source:` lines; no need to handle both being present simultaneously.

**Alternatives considered**:
- Combine into one configurable marker like `Source: abstract-derived (stale=true)`: less readable; harder to grep; harder to evolve as more derivation modes appear.
- Emit at the top of the meta block: more prominent but disrupts the existing visual hierarchy. Right next to `Type:` reads as a content-source classifier, which is what it is.

## D7 — Find-nodes preview annotation (out of scope per spec)

**Decision**: do NOT extend `h-find-nodes` preview rendering with a stale-abstract annotation in this spec. The spec's Assumptions explicitly defer this; the plan honours the deferral. `h-find-nodes` doesn't even need to project `abstractOriginHash` in its Prisma select.

**Rationale**: previews are already visually dense (per-hit header + description + abstract block + tags + brief edges). Adding a per-hit staleness annotation competes for attention with the actual hit content; some hits are fresh, some stale, the annotation creates visual clutter. The right consumer for staleness on find is the **caller's discretion** — they can fetch the node's `abstractOriginHash` via `h-read-node` or GraphQL when they want to act on it. Tracking in the gap-issue at hadron-server#206 as item 5.

**Alternatives considered**:
- Emit a `(stale)` suffix on the abstract preview line: cheap but increases the per-hit visual complexity; the RAG follow-up might encode this differently anyway (vectorizer-side handling).
- Add a `staleOnly: bool` filter to `h-find-nodes`: filters hits by staleness; potentially useful but out of scope here.

## D8 — NodeVersion is a first-class entity from day one

**Decision**: every Phase 2 task involving Node-write paths explicitly includes the matching NodeVersion edit (snapshot capture + `restoreNodeVersion` write payload). Migration adds the column to BOTH `nodes` AND `node_versions` in the same migration file.

**Rationale**: this is the lesson learned from spec 031 the hard way (caught in PR-201 review as a real bug in `restoreNodeVersion` — abstract was silently dropped on restore). Documented in CLAUDE.md and as a project memory; baked into the spec (FR-002 + Entity Impact + Edge Case 7) and the tasks template (see tasks.md once generated). The implementer cannot accidentally forget the NodeVersion side.

**Sites that need editing for FR-002 compliance** (will be enumerated in tasks.md):
1. `prisma/schema.prisma` — NodeVersion model gains `abstractOriginHash String?`
2. The migration SQL — adds the column to `node_versions` table
3. `src/api/graphql/schema/resolvers.ts:upsertNode` — `nodeVersion.create` snapshot captures `existing.abstractOriginHash`
4. `src/api/graphql/schema/resolvers.ts:restoreNodeVersion` — pre-restore snapshot captures live `abstractOriginHash`; restore-write applies `version.abstractOriginHash`
5. `src/mcp/server.ts:h-update-node` — `nodeVersion.create` snapshot captures `existing.abstractOriginHash`
6. `src/mcp/server.ts:h-move-node` — `nodeVersion.create` snapshot captures `existing.abstractOriginHash`

## D9 — Test layout

**Decision**:
- **NEW**: `src/mcp/server.nodeAbstractStaleness.test.ts` — dedicated matrix tests covering the FR-003 through FR-007 hash-write semantics across `h-add-node` and `h-update-node`, plus the `Source: abstract-stale` marker emission on `h-read-node`, plus the `[stale-abstract]` validator warning.
- **Extend** `src/test/integration/node-abstract.test.ts` — GraphQL `upsertNode` hash semantics (same matrix); `restoreNodeVersion` hash round-trip (verifies FR-002 + D4); GraphQL contract test that `NodeInput.abstractOriginHash` does NOT exist (FR-012 / SC-005).
- **Extend** `src/integrations/localFs/loadNodeFromFs.test.ts` — YAML round-trip (importer reads / exporter writes the `abstractOriginHash:` key per FR-013).
- **Extend** `src/api/graphql/schema/resolvers.encryption.test.ts` — hash is computed on plaintext content on encrypted memories; the column stays plaintext; the staleness signal works end-to-end across an encrypted memory (FR-009).

**Rationale**: keep dedicated matrix coverage in a focused file (mirrors `server.nodeAbstract.test.ts` from spec 031). Extension into existing files is for cross-cutting concerns that already have the right setup (encryption fixtures, YAML round-trip fixtures).

## D10 — Performance posture

**Decision**: no new index. The staleness check is a column-vs-column string compare at read time; no scan, no lookup. The hash computation runs once per write at `O(content length)`; well within the existing write-path budget.

**Rationale**: same posture as spec 031. If a future surface needs "find all stale abstracts in a memory" as a query, a composite index on `(memoryId, abstractOriginHash, contentHash)` could help — but the RAG follow-up is more likely to read via batch / streaming than via a single SQL filter, so the index isn't presumed-needed.

**Alternatives considered**:
- Pre-compute a derived `is_stale BOOL` column: avoids the comparison at read time but the comparison cost is negligible; a derived column needs to be kept in sync (failure mode), and adds storage.
