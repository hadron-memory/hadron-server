# Implementation Plan: Memory access rules — class-driven, user-ownable

**Branch**: `199-memory-class-access` | **Date**: 2026-06-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/034-memory-class-access/spec.md`

## Summary

Make access **`Memory.class`-driven** and memories **user-ownable**. Concretely:
allow `personal`/`private` to be created (incl. **free-standing**, no app, owned by
a user); enforce owner-only for them with **no ADMIN/OWNER bypass**; drop
`MemoryVisibility.PERSONAL`/`PRIVATE` (visibility becomes nullable
`{PUBLIC, ORGANIZATION, GROUP}`, used only by `knowledge`/`group`); remove
`Memory.type`; re-key the ownership CHECKs from `visibility` to `class`; relax the
`app_id` CHECK to `class=app` only; and make `organizationId` nullable for
user-owned memories. No new entities; sharing stays on the existing `MemoryShare`;
groups/`Memory.role` are a deferred future layer.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥ 22, `strict: true` (constitution S1)
**Primary Dependencies**: Prisma + PostgreSQL; GraphQL (`src/api/graphql/`) + MCP; Vitest
**Storage**: PostgreSQL; schema `prisma/schema.prisma`; CHECKs `prisma/post-push.sql`; enum-type-swap migration
**Testing**: Vitest against real `hadron_test`; integration tests in `src/test/integration/`
**Target Platform**: Linux server (Hadron API/MCP)
**Project Type**: Single web-service repo (GraphQL + MCP over Prisma)
**Performance Goals**: No new hot-path cost; one-time schema/enum migration on a small cohort
**Constraints**: Typed errors at the GraphQL boundary (S2); all reads/writes through the access-control layer (Principle V); CHECK + regression test per new DB invariant (S5)
**Scale/Scope**: MVP cohort (one external customer); existing rows reconfigured by hand

## Constitution Check

*GATE: re-checked after Phase 1 — PASS.*

- **Principle I (test-first, server scope)** — every access-control mutation gets
  an integration test in `src/test/integration/`: `createMemory(personal|private,
  free-standing & in-app)`, the owner-only read/write predicate, `MemoryShare`
  grant/revoke on `personal`, `private` share-rejection, `PUBLIC` knowledge
  unauth-read, and `Memory.type`-removal parity. **PASS.**
- **Principle II (docs-concurrent)** — `MemoryVisibility`/`Memory.type`/`createMemory`
  doc-comments in `typeDefs.ts` updated in-PR; the class→access rule documented in
  platform-specs. **PASS.**
- **Principle III + S2 (typed errors)** — `createMemory` rejections (share a
  `private`, change class/owner, app-key creating a user-owned memory) return typed
  errors with stable `extensions.code`. **PASS.**
- **Principle V (zero-trust enforcement)** — the owner-only rule lives in
  `resolveMemoryAuthorization` + the MCP gate; owner check is `Memory.userId`,
  never `createdBy`; no resolver bypass. **PASS.**
- **S5 (CHECKs + regression test)** — the re-keyed/added CHECKs (`chk_memory_personal_owner`,
  `chk_memory_private_owner`, `chk_memory_visibility_class`, relaxed
  `chk_memory_class_app_id`) land in `post-push.sql` with regression tests. **PASS.**
- **S3 (`typeDefs.ts` one template literal, no raw backticks)** — doc-comment edits
  avoid backticks. **PASS.**
- **Spec-location note** — constitution's *Spec Workflow* says specs live in
  `spec-kits/specs/`; current practice (031–034 + the 2026-05-28 convention) puts
  them in `hadron-server/specs/`. This spec follows current practice; constitution
  clause is stale. Flagged per Conflict-Resolution.

No violations → no Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/034-memory-class-access/
├── plan.md          # this file
├── spec.md          # rewritten spec (class-driven, user-ownable)
├── research.md      # Phase 0 — decisions for the final model
├── data-model.md    # Phase 1 — Memory fields, CHECKs, class→access table, migration
├── quickstart.md    # Phase 1 — end-to-end validation
├── contracts/
│   └── createMemory-and-authz.md
└── checklists/requirements.md
```

### Source Code (repository root)

```text
prisma/
├── schema.prisma                         # drop Memory.type+MemoryType; prune+nullable MemoryVisibility;
│                                         #   organizationId nullable; (owner stays userId + existing links)
├── post-push.sql                         # re-key ownership CHECKs onto class; relax app_id CHECK
└── migrations/<ts>_memory_class_access/  # enum type-swap (MemoryVisibility), drop MemoryType, nullable cols, CHECKs

src/
├── api/graphql/schema/
│   ├── resolvers.ts                      # createMemory opens personal/private (free-standing);
│   │                                     #   read/write surfaces honor class owner-only; knowledge per visibility (PUBLIC unauth)
│   └── typeDefs.ts                        # remove MemoryType; update MemoryVisibility; doc-comments
├── lib/auth/
│   └── resolveMemoryAuthorization.ts     # personal/private → owner-only; drop agent/AgentSubscription requirement
├── mcp/access-control.ts                 # parity for free-standing owner-only
└── test/integration/
    ├── 034-owner-only-memory.test.ts
    ├── 034-createMemory-personal-private.test.ts
    ├── 034-visibility-type-cleanup.test.ts
    └── 034-memoryshare-personal.test.ts
```

**Structure Decision**: Single-repo web service; all changes in `hadron-server`
(Prisma schema/migration, GraphQL resolvers + typeDefs, the auth predicate, the
MCP gate, integration tests) plus a platform-specs doc node for the class→access
rule. No new project, module, or access entity.

## Complexity Tracking

No constitution violations to justify.
