# Quickstart — validating Memory access rules (class-driven, user-ownable)

Prereqs: `hadron_test` reachable; `pnpm test`; re-apply `prisma/post-push.sql`
after any `db push` (constitution S5).

## 1. User-owned, free-standing owner-only memory (US1 / SC-001, SC-002)

```
# As user A (org READER, OR a user with no org), no active app:
createMemory(name: "A's notes", class: private)        # → userId=A, app_id=NULL, visibility=NULL
upsertNode(memoryId: <A's mem>, loc: "n1", ...)         # A can write            → SC-002

# user B, an org ADMIN, and a platform OWNER each:
memory(id) / myMemories / organization.memories / nodes / nodeSearch  # never see it
upsertNode(...)                                          # forbidden            → SC-001
```

## 2. Personal sharing via MemoryShare; private never shareable (US1 / SC-006)

```
# personal memory owned by mom:
MemoryShare(memory: user-mom, grantee: dad, role: writer)   # dad can read+write
# revoke:
delete MemoryShare row                                       # dad loses access immediately
# private:
MemoryShare(memory: priv-mom, ...)                           # rejected (typed error)
```

## 3. Class access + knowledge visibility (US2 / SC-003)

```
pnpm vitest run src/api/graphql/schema/resolvers.accessControl.test.ts   # stays green
# knowledge ORGANIZATION → org members read; PUBLIC → unauthenticated read:
memory(id: <public-knowledge>)  as unauthenticated     # readable
# system → app member read, not write; app → app member read+write
```

## 4. Visibility/type cleanup + CHECKs (US3 / SC-004, SC-005)

```
# After enum type-swap + post-push.sql:
#  - MemoryVisibility has exactly {PUBLIC, ORGANIZATION, GROUP}
#  - personal/private/system/app rows have visibility = NULL
#  - chk_memory_personal_owner / chk_memory_private_owner reject userId NULL
#  - chk_memory_class_app_id rejects app_id NULL only for class=app
#  - personal/private CAN exist with app_id NULL (free-standing)
pnpm vitest run src/test/integration/034-visibility-type-cleanup.test.ts
grep -rn "AGENT_SYSTEM" src --include=*.ts   # only class-derived / docs; no Memory.type field reads
pnpm test                                     # full suite green → SC-005
```

## Done when

SC-001…006 pass, the full suite is green, and the class→access rule is documented
in platform-specs. No `Group`/`MemoryAccess`/`Memory.role` introduced.
