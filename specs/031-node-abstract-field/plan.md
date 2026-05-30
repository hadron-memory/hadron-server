# Implementation Plan: Node `abstract` field — paragraph-length preview

**Branch**: `031-node-abstract-field-plan` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from [specs/031-node-abstract-field/spec.md](./spec.md)

## Summary

Add an optional `abstract` text column to the `Node` Prisma model + GraphQL type. Wire it through five MCP tools (`h-add-node`, `h-update-node`, `h-read-node`, `h-find-nodes`, `h-validate`), the node.yaml importer/exporter, and the existing access-control + audit paths. Most of the work is mechanical column-plumbing; the load-bearing logic lives in two places: (1) `h-read-node`'s new `contentScope` parameter with the asymmetric content-fallback rule + `Source: abstract-fallback` meta marker, and (2) `h-find-nodes`' preview rendering with `brief: true` as the off-switch. Backwards-compat is preserved by FR-005's default-mode byte-identical promise.

## Technical Context

- **Language/Version**: TypeScript 5.x on Node.js ≥ 22 (per server constitution S1)
- **Primary Dependencies**: Prisma 5.x (PostgreSQL), `@modelcontextprotocol/sdk` (MCP server), Apollo Server (GraphQL), `zod` (tool input validation), `js-yaml` (importer/exporter via `src/integrations/github/`)
- **Storage**: PostgreSQL — `hadron_dev` for local manual runs, `hadron_test` for vitest (pinned by `vitest.config.ts`). Schema migration via `prisma db push` on the two dev DBs (no `prisma migrate` history per CLAUDE.md), and a hand-authored migration file under `prisma/migrations/` for production.
- **Testing**: Vitest. Unit tests adjacent to source; integration tests under `src/test/integration/` per constitution refinement I. New snapshot fixtures for h-read-node's three `contentScope` shapes × abstract-state × content-state cells.
- **Target Platform**: Linux server (hadron-server production deployments behind Cloudflare per spec 025)
- **Project Type**: web-service (MCP transport at `/mcp` + GraphQL API)
- **Performance Goals**: No measurable change to `h-find-nodes` p50/p95 vs pre-spec — abstract joins the existing in-memory haystack (one extra column concat). No new index in v1; trigram is a follow-up if profiling shows degradation.
- **Constraints**: Default-mode output byte-identical to pre-spec for every existing caller (FR-005, SC-004); 2000-char hard cap on abstract; partial-update semantics on `h-update-node` (omitted ≠ clear).
- **Scale/Scope**: Small — one schema column, one migration, ~5 MCP tool surfaces touched (3 modified, 1 surface-modified for preview, 1 surface-modified for validation), ~5 test files modified/added, 1 GraphQL type extended, 1 importer module touched.

## Constitution Check

*Gate: must pass before Phase 0 research. Re-checked after Phase 1 design.*

### Server constitution (this repo, v1.0.0 pinned at parent v1.3.0)

| Item | Applies? | Compliance |
|------|----------|------------|
| S1 — Stack pin (TS/Node ≥22/Prisma/Postgres/Vitest/GraphQL/strict) | yes | ✓ All work stays within the pinned stack. No new framework, no schema-language change. |
| S2 — Typed-error boundary | yes | ✓ Two new error classes added: `NodeAbstractTooLongError` (length-cap violation) and `InvalidContentScopeError` (enum violation). Both extend the typed-error base in `src/lib/entityRef/errors.ts` per the established pattern. |
| S3 — `typeDefs.ts` is one backtick template literal | yes | ✓ New `abstract: String` line on `Node` type; doc-comment uses no backticks (uses single quotes for the `'Source: abstract-fallback'` example). |
| S4 — Composite-PK models in MODELS_WITHOUT_ID | n/a | `Node` has an auto-generated `id` — not composite-PK. |
| S5 — CHECK constraints in `prisma/post-push.sql` | n/a | No CHECK constraint added. The 2000-char cap is enforced at the API boundary (zod schema + GraphQL resolver), not in the database — caps are validation, not invariants. |
| S6 — CI grep gates stay in sync | n/a | No new grep gate introduced. |
| I — Test-first (server refinement: integration tests for graph-touching MCP tools) | yes | ✓ `h-add-node`, `h-update-node`, `h-read-node`, `h-find-nodes`, `h-validate` all get integration test coverage extending the existing files. Tests run against `hadron_test`. |
| II — Docs-concurrent (GraphQL doc-comments + migration intent) | yes | ✓ `Node.abstract` doc-comment in `typeDefs.ts` co-canonical with `hadron-docs`. Migration file gets a header comment citing the spec ID. Prisma model doc-comment in `schema.prisma` describes the column. |
| III — Typed errors at the GraphQL boundary | yes | ✓ See S2. |
| V — Zero-Trust Apps; every MCP tool through access-control | yes | ✓ No new access-control surface — existing `canReadMemory` / `canWriteToMemory` gates apply to the modified tools unchanged. |

### Spec Workflow invariant — **tension flagged**

The server constitution's Spec Workflow section says: *"All Hadron specs — including server-only specs — live under `spec-kits/specs/NNN-name/`. The server repo does NOT host its own `specs/` directory."*

This spec (and its plan) live under `hadron-server/specs/031-node-abstract-field/`, not under `spec-kits/specs/`. This is a deliberate divergence from the constitution at the project owner's direction (2026-05-28), motivated by: (a) the cross-repo workflow has been awkward in practice, and (b) historical specs 005–030 stay in `spec-kits/` so there is no migration burden — only new specs from 031 onward land in-repo.

Per the constitution's own Conflict Resolution clause ("unresolved tension MUST be called out in the affected `plan.md` rather than silently chosen"), this is the explicit call-out. Resolution paths:

1. **Amend the server constitution** to align the Spec Workflow section with the new in-repo convention (recommended — practice has already shifted).
2. **Treat 031 as a one-off** and revert future specs to `spec-kits/specs/` (deprecated by user direction).
3. **Leave the tension open** and let each future spec navigate it.

The plan proceeds with the in-repo convention. A constitutional amendment is tracked as a follow-up out of scope for this spec.

### Parent constitution (Hadron-wide v1.3.0)

| Principle | Compliance |
|-----------|------------|
| I (pragmatic test-first) | ✓ Integration tests for MCP tools; snapshot tests for response shapes. |
| II (docs-concurrent) | ✓ Schema doc-comments + migration header + GraphQL doc-comment in same release. |
| III (accessible non-technical) | ✓ Typed errors with friendly messages; spec was written with explicit response-shape examples. |
| IV (brainstorm → spec → implement) | ✓ Spec exists at [spec.md](./spec.md), Background paragraph documents the RAG-substrate motivation. |
| V (zero-trust Apps) | ✓ All access-control paths preserved. |
| VI (spec-code coherence) | ✓ Plan + tasks land in the same release as code; doc-comments + tests pin the contract. |

**Constitution gate (pre-Phase-0)**: ✓ pass (with one explicit tension flagged + a path-forward proposal).

**Constitution gate (post-Phase-1)**: ✓ unchanged. Phase 1 artifacts (data-model.md + 7 contract
docs + quickstart.md) introduce no new constitutional concerns. Two typed errors are formalized
in the data-model (NodeAbstractTooLongError, InvalidContentScopeError) per S2/III; doc-comment
placement in `schema.prisma` and `typeDefs.ts` adheres to S3 (no raw backticks); the migration
shape is online-safe per the existing additive-column convention; no new CHECK constraint or grep
gate added. Integration tests for every modified MCP tool listed in research.md D9 satisfy
refinement I. Spec Workflow tension unchanged — still flagged, no resolution required for
implementation.

## Project Structure

### Documentation (this feature)

```text
specs/031-node-abstract-field/
├── plan.md              # This file
├── spec.md              # Feature specification (already merged via PR #194)
├── research.md          # Phase 0 output — design decisions log
├── data-model.md        # Phase 1 output — schema diff + migration shape
├── quickstart.md        # Phase 1 output — manual smoke recipe
├── contracts/           # Phase 1 output — per-tool contract docs
│   ├── h-add-node.md
│   ├── h-update-node.md
│   ├── h-read-node.md
│   ├── h-find-nodes.md
│   ├── h-validate.md
│   ├── graphql-node-type.md
│   └── importer-yaml.md
├── checklists/
│   └── requirements.md  # Already exists from /speckit-specify
└── tasks.md             # Phase 2 output — created by /speckit-tasks (not this command)
```

### Source code (repository root)

```text
hadron-server/
├── prisma/
│   ├── schema.prisma                            # Node model gains `abstract String?`
│   └── migrations/
│       └── YYYYMMDDHHMMSS_node_abstract/        # NEW migration directory
│           └── migration.sql                    # ALTER TABLE nodes ADD COLUMN abstract TEXT
├── src/
│   ├── api/
│   │   └── graphql/
│   │       └── schema/
│   │           ├── typeDefs.ts                  # Node.abstract: String field added
│   │           └── resolvers.ts                 # Node resolver passes abstract through
│   ├── integrations/
│   │   └── github/
│   │       ├── syncGraphFromGithub.ts           # YAML → Node: read abstract
│   │       └── writeNodeToGit.ts                # Node → YAML: write abstract
│   ├── lib/
│   │   └── entityRef/
│   │       └── errors.ts                        # NEW typed errors: NodeAbstractTooLongError, InvalidContentScopeError
│   ├── mcp/
│   │   ├── server.ts                            # 5 tools modified (see contracts/)
│   │   ├── server.findReadList.test.ts          # extended: abstract preview + contentScope + fallback
│   │   ├── server.addEdge.test.ts               # extended: abstract on add/update
│   │   └── server.nodeAbstract.test.ts          # NEW: dedicated abstract round-trip + fallback fixtures
│   └── test/
│       └── integration/
│           └── node-abstract.test.ts            # NEW: GraphQL integration test
└── CLAUDE.md                                    # SPECKIT block updated to point here
```

**Structure decision**: single project (Option 1 — there is no frontend in this spec, and the
portal-side rendering is explicitly out of scope per the spec's Assumptions). The "models / services
/ cli / lib" abstraction from the speckit template doesn't fit hadron-server's existing layout
(`api/`, `mcp/`, `integrations/`, `lib/`, `test/`); the real-paths tree above is the operative
structure.

## Complexity Tracking

No constitutional violations to justify beyond the Spec Workflow tension noted above (which is
flagged per the constitution's own process, not a violation requiring justification).
