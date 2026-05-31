# Implementation Plan: Node `abstractOriginHash` — stale-abstract detection

**Branch**: `199-abstract-staleness` *(spec-dir number `032` per the divergence documented in the spec frontmatter)*
**Date**: 2026-05-31
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification from [specs/032-abstract-staleness/spec.md](./spec.md)

## Summary

Add one nullable text column to `Node` (and matching column to `NodeVersion`), maintain it automatically on every write surface so the value reflects "hash of the content this abstract was derived from," and surface the divergence (`abstractOriginHash != contentHash`) as a staleness signal on two read surfaces (`h-read-node` marker, `h-validate` warning). GraphQL exposes the field read-only. No new typed errors — staleness is observable, not throwable.

**Smaller than spec 031**: one column, no `contentScope`-style matrix, no encryption envelope changes (the hash is plaintext metadata that rides outside the encrypted set). The load-bearing complexity is making sure every Node write surface (MCP × 2, GraphQL × 1, importer × 1, restoreNodeVersion × 1) updates the hash with the right semantics — that's where the FR-003 / FR-004 / FR-005 / FR-006 / FR-007 matrix lives.

**NodeVersion as a first-class entity from day one** — spec 031 learned this lesson the hard way (caught in PR-201 review as a real bug in `restoreNodeVersion`). For 032 it's in the spec (FR-002 + Entity Impact + Edge Case 7), in the data-model from the start, and called out as a Phase 2 task in tasks.md.

## Technical Context

- **Language/Version**: TypeScript 5.x on Node.js ≥ 22 (per server constitution S1)
- **Primary Dependencies**: Prisma 5.x (PostgreSQL), `@modelcontextprotocol/sdk` (MCP server), Apollo Server (GraphQL), `zod` (tool input validation), `js-yaml` / `yaml` (importer/exporter). Hash machinery: reuse the existing `Node.contentHash` helper (SHA256[0:N]; no new crypto primitives).
- **Storage**: PostgreSQL. `hadron_dev` for local; `hadron_test` for vitest. Schema delta via `prisma db push` on dev/test, hand-authored migration file under `prisma/migrations/` for production. **Two columns** (`nodes.abstract_origin_hash`, `node_versions.abstract_origin_hash`) added by **one migration** (cheap; both are nullable text, both online-safe with the same `lock_timeout` pattern established in 031).
- **Testing**: Vitest. Three new / extended files: `src/mcp/server.nodeAbstractStaleness.test.ts` (NEW — staleness matrix); `src/test/integration/node-abstract.test.ts` (extend — restoreNodeVersion + GraphQL upsertNode hash semantics); `src/integrations/localFs/loadNodeFromFs.test.ts` (extend — YAML round-trip of the hash); `src/api/graphql/schema/resolvers.encryption.test.ts` (extend — hash is plaintext metadata on encrypted memories).
- **Target Platform**: Linux server (hadron-server production deployments)
- **Project Type**: web-service (MCP transport + GraphQL API)
- **Performance Goals**: hash computation is `O(content length)` and runs once per write — far below the existing write-path budget. No measurable change to read latency (one extra column read; staleness check is a string compare). No new index in v1.
- **Constraints**: Pre-spec backwards compatibility — every existing node has `abstractOriginHash IS NULL`; staleness check short-circuits when either side is null; no false positives on legacy content. The marker / validator warning MUST NOT fire on legacy nodes.
- **Scale/Scope**: One column, one migration delta (adds column to both `nodes` and `node_versions`), ~4 MCP/GraphQL write-path edits (each `nodeVersion.create` site + `restoreNodeVersion`'s update payload), one h-read-node marker emission, one h-validate check, one GraphQL type field, one importer key, one exporter key. ~6 new tests, ~3 extended tests.

## Constitution Check

*Gate: must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Server constitution (this repo, v1.0.0 pinned at parent v1.3.0)

| Item | Applies? | Compliance |
|------|----------|------------|
| S1 — Stack pin | yes | ✓ TypeScript / Node ≥ 22 / Prisma / Postgres / Vitest / GraphQL — no changes |
| S2 — Typed-error boundary | n/a | No new errors. Staleness is observable, not throwable; the existing length-cap / invalid-scope errors from spec 031 still apply unchanged. |
| S3 — `typeDefs.ts` is one backtick template literal | yes | ✓ New `abstractOriginHash: String` field on `Node` type uses no backticks in its doc-comment |
| S4 — Composite-PK models | n/a | `Node` and `NodeVersion` both have id columns |
| S5 — CHECK constraints in `prisma/post-push.sql` | n/a | No CHECK constraint added — the column is a fingerprint, not an invariant |
| S6 — CI grep gates | n/a | No new grep gate |
| I — Test-first (integration tests for graph-touching MCP tools) | yes | ✓ `h-add-node`, `h-update-node`, `h-read-node`, `h-validate`, GraphQL `upsertNode`, `restoreNodeVersion`, importer — all get integration coverage in the test files named above |
| II — Docs-concurrent (GraphQL doc-comments + migration intent) | yes | ✓ `Node.abstractOriginHash` doc-comment in `typeDefs.ts`; migration file header cites the spec ID; Prisma model doc-comment describes the column |
| III — Typed errors at the GraphQL boundary | n/a | No new errors at the GraphQL boundary; existing error classes from 031 cover everything callable in this surface |
| V — Zero-Trust Apps; every MCP tool through access-control | yes | ✓ No new access-control surface — existing `canReadMemory` / `canWriteToMemory` gates on the modified tools unchanged. `abstractOriginHash` is system-managed; callers can't supply it (FR-012), so there's no caller-side authority concern |

### Spec Workflow invariant — same tension as 031

The server constitution's Spec Workflow section says specs live under `spec-kits/specs/`. This spec (and its plan) live under `hadron-server/specs/032-abstract-staleness/`, continuing the in-repo convention established by spec 031 per the 2026-05-28 user direction. Same flag, same proposed resolution path (amend the server constitution); already accepted as ongoing.

### Parent constitution (Hadron-wide v1.3.0)

| Principle | Compliance |
|-----------|------------|
| I (pragmatic test-first) | ✓ Integration tests for every modified surface; snapshot tests for the new marker shape |
| II (docs-concurrent) | ✓ Schema doc-comments + migration header + GraphQL doc-comment in same release |
| III (accessible non-technical) | ✓ User-visible marker (`Source: abstract-stale`) + validator message (`[stale-abstract] urn — abstract may not reflect current content`) both explain the situation in plain language |
| IV (brainstorm → spec → implement) | ✓ Spec exists at [spec.md](./spec.md); Background documents the RAG-precursor motivation |
| V (zero-trust Apps) | ✓ Access control preserved; field is system-managed (FR-012) |
| VI (spec-code coherence) | ✓ Plan + tasks land in same release as code; doc-comments + tests pin the contract |

**Constitution gate (pre-Phase-0)**: ✓ pass (Spec Workflow tension is the same one flagged by spec 031; no new violations).

**Constitution gate (post-Phase-1)**: ✓ unchanged. Phase 1 artifacts (data-model + 5 contracts + quickstart) introduce no new constitutional concerns. No new typed errors needed; no new CHECK constraints; doc-comments stay within S3.

## Project Structure

### Documentation (this feature)

```text
specs/032-abstract-staleness/
├── plan.md              # This file
├── spec.md              # Feature specification (in this PR)
├── research.md          # Phase 0 — design decisions log (this PR)
├── data-model.md        # Phase 1 — schema diff + migration shape (this PR)
├── quickstart.md        # Phase 1 — manual smoke recipe (this PR)
├── contracts/           # Phase 1 — per-tool contract docs (this PR)
│   ├── h-add-node.md
│   ├── h-update-node.md
│   ├── h-read-node.md
│   ├── h-validate.md
│   ├── graphql-node-type.md
│   └── importer-yaml.md
├── checklists/
│   └── requirements.md  # From /speckit-specify
└── tasks.md             # Phase 2 — created by /speckit-tasks (next)
```

### Source code (repository root)

```text
hadron-server/
├── prisma/
│   ├── schema.prisma                            # Node + NodeVersion each gain `abstractOriginHash String?`
│   └── migrations/
│       └── YYYYMMDDHHMMSS_abstract_origin_hash/ # NEW migration directory
│           └── migration.sql                    # BEGIN; SET LOCAL lock_timeout = '5s'; ALTER TABLE … two ADD COLUMNs; COMMIT;
├── src/
│   ├── api/
│   │   └── graphql/
│   │       └── schema/
│   │           ├── typeDefs.ts                  # Node gains `abstractOriginHash: String` (read-only — NOT on NodeInput)
│   │           └── resolvers.ts                 # upsertNode + restoreNodeVersion thread hash through
│   ├── integrations/
│   │   ├── github/
│   │   │   ├── syncGraphFromGithub.ts           # passes imported abstractOriginHash through to upsert
│   │   │   └── writeNodeToGit.ts                # writes abstractOriginHash key to YAML frontmatter
│   │   └── localFs/
│   │       └── loadNodeFromFs.ts                # reads abstractOriginHash from YAML; recomputes when absent
│   ├── lib/
│   │   └── contentHash.ts                       # MAYBE — shared helper if there isn't already one (see research D3)
│   └── mcp/
│       ├── server.ts                            # h-add-node, h-update-node, h-read-node, h-validate, h-move-node touched
│       └── server.nodeAbstractStaleness.test.ts # NEW
└── CLAUDE.md                                    # SPECKIT block updated to point at this plan
```

**Structure decision**: single project (Option 1) — same as spec 031. No frontend changes in scope; portal-side rendering of the staleness marker is a follow-up (per spec Assumptions).

## Complexity Tracking

No constitutional violations to justify beyond the Spec Workflow tension already noted (same one accepted for spec 031, ongoing).

**Two open questions from the spec checklist resolved during plan**:

1. **Q1 — Should `restoreNodeVersion` recompute `abstractOriginHash` from restored content when the version's stored hash is `null` (legacy version restored post-spec)?** → **NO**. Restoring leaves `abstractOriginHash IS NULL` on the live row; the staleness check short-circuits; no false signal. Recomputation would be asymmetric with how other columns are restored (verbatim) and could surprise users who expect "restore = byte-identical to the version." See research D4.

2. **Q2 — Should `h-validate`'s stale-abstract check be flag-gated so users on memories with many legacy abstracts can opt out?** → **NO** in v1. Legacy abstracts have `abstractOriginHash IS NULL` and naturally don't trigger the warning (FR-007 edge-case behaviour). Memories with mostly legacy content stay quiet by design. If the warning becomes noisy in practice on memories with mixed legacy + post-spec content, add a flag in a follow-up. See research D5.
