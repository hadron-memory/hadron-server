# Phase 0 Research — Memory access rules (class-driven, user-ownable)

Decisions are from the design discussion (final [summary.md](../../../hadron-concept/design-discussions/memory/2026-06-04-memory-access-rules/summary.md)); the stack is fixed by the constitution. Each item resolves an implementation choice.

## R1 — `class` is the access axis; no `Memory.role`

**Decision**: Use the existing `MemoryClass` (`system, app, knowledge, personal,
group, private`) as the sole access-determining field. Do **not** add a
`Memory.role`.

**Rationale**: `class` already enumerates exactly the access kinds; a `role` field
would be a rename with a migration. Access = `class` + owner + app/org membership +
`MemoryShare`, per the data-model table. (D-2026-06-05-002.)

**Alternatives**: a new `role` field (rejected — redundant); a full group ACL
(`Group`/`MemoryAccess`) (rejected for v1 — see R7).

## R2 — Drop `MemoryVisibility.PERSONAL`/`PRIVATE` via enum type-swap

**Decision**: `MemoryVisibility = {PUBLIC, ORGANIZATION, GROUP}`, **nullable**,
non-null only for `class IN {knowledge, group}`. Implement by creating a new enum
type and swapping the column (Postgres can't `DROP VALUE`), mapping existing rows:
`personal`/`private` → NULL; `knowledge` `PRIVATE`→`ORGANIZATION` (or hand-fix);
`group`→`GROUP`.

**Rationale**: `PERSONAL`/`PRIVATE` were redundant class markers and the source of
the human/AI ambiguity. (D-2026-06-05-002.) Type-swap is the standard safe path.

**Alternatives**: keep as class-bound markers (rejected — the markers *are* the
confusion); leave value in enum but unused (rejected — invites misuse).

## R3 — Re-key ownership CHECKs from `visibility` to `class`

**Decision**: `chk_memory_personal_owner` (`class=personal ⇒ userId NOT NULL`,
replacing `chk_personal_visibility_user`), `chk_memory_private_owner`
(`class=private ⇒ userId NOT NULL`), keep `chk_memory_group_visibility`
(`class=group ⇔ visibility=GROUP`), add `chk_memory_visibility_class` (`visibility
NOT NULL` only for knowledge/group). Each with a regression test (S5).

**Rationale**: Ownership is a property of `class`, not `visibility`; the old CHECK
keyed on the visibility marker we're removing.

## R4 — User-ownable + free-standing `personal`/`private`; relax `app_id`

**Decision**: Make `organizationId` **nullable**; `userId` carries user-ownership
for `personal`/`private`. Relax `chk_memory_class_app_id` to **`class=app ⇒ app_id
NOT NULL`** only — `personal`/`private` may have `app_id NULL` (free-standing) or
set (the `(app, user)` scope). Agent ownership (`system`) and app ownership (`app`)
stay expressed by the existing linkage (`Agent.systemMemoryId`, `app_id`); a
dedicated `ownerAgentId`/`ownerAppId` column pair is **optional polish**, not
required for v1.

**Rationale**: Portability + the original incident fix (a user-owned, app-less
owner-only memory). (D-2026-06-05-001.) Keeping owner expression on existing
columns minimizes churn while satisfying the typed-one-of intent.

**Alternatives**: polymorphic `(ownerType, ownerId)` (rejected — kills FK integrity
and org-scoped queries); add four explicit owner FK columns now (deferred — more
migration than v1 needs).

## R5 — Encryption opt-in on `private` only; implementation deferred

**Decision**: only `class=private` may set `encrypted=true` (default false). The
crypto + key custody are **out of scope**; the flag is a contract. UI must not imply
"private ⇒ encrypted."

**Rationale**: D-2026-06-04-002 (lock relaxed) + the deferred key-custody problem
for app-less owners.

## R6 — Remove `Memory.type`

**Decision**: drop `Memory.type` + `MemoryType`; replace each read with `class`
(`type=AGENT_SYSTEM` → `class='system'`; list filters `type != AGENT_SYSTEM` →
`class != 'system'`). Gate the column drop on verifying `type=AGENT_SYSTEM ⇔
class=system` in current data.

**Rationale**: vestigial axis fully derivable from `class`. Sites:
`resolvers.ts` (~lines 455, 1198–1203, 2634, 2652, 2677, 4305, 4382, 4441, 4520) +
`typeDefs.ts` (enum + doc). A parity integration test pins no-behavior-change.

## R7 — No groups in v1; sharing via existing `MemoryShare`

**Decision**: do not build `Group`/`AssignedGroup`/`MemoryAccess`/`memberDefault`.
`personal` sharing uses the existing `MemoryShare(reader|writer)`; revoke = row
delete (immediate). `private` rejects all shares.

**Rationale**: the live customer (Juno) and every reference agent's core flow are
covered by `class` + `MemoryShare`; the group ACL forces the hard
define-time→install-time resolution and context-dependent grants. Groups are the
documented future additive layer (class = baseline; grants raise allow-only).
(D-2026-06-05-003.)

## R8 — Keep `PUBLIC` (deliberate, one-way publish)

**Decision**: keep `MemoryVisibility.PUBLIC`; `knowledge` with `PUBLIC` is readable
unauthenticated (the code already has the unauth path). Publishing is an explicit,
effectively one-way action; never a default; mind PII.

**Rationale**: public memories are legitimate (public-domain-style). (D-2026-06-05-002.)

## R9 — Predicate reshape for free-standing owner-only

**Decision**: `resolveMemoryAuthorization`'s `personal`/`private` branch reduces to
*allow iff caller is the owner* (`callerUserId === Memory.userId`); **drop** the
`userMemoryOfAgentId`-non-null requirement and the up-front `AgentSubscription`
license check. The optional agent-on-behalf branch may remain when an agent context
is present and matches, but is never required.

**Rationale**: a free-standing owner-only memory has no agent; the license check
gates *agent* interaction. (D-2026-06-04-002 / Q5.)

## R10 — Roll out the predicate change as a strangler (shadow parity)

**Decision**: for the auth-decision change, compute the new decision alongside the
old on real traffic where feasible and assert parity in tests before cutover,
rather than a flag-day swap. (Lightweight here — the change is contained — but the
discipline matches the spec-027 audit pattern.)

## Resolved / no open NEEDS CLARIFICATION

`personal` scope = `(app, user)` (free-standing allowed); role names = class names;
owner of `app`/`standard` = the app/install (existing `app_id`); `standard` =
`class=knowledge`. All pinned in the discussion.
