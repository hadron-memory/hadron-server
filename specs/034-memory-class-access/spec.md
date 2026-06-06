# Feature Specification: Memory access rules — class-driven, user-ownable

**Feature Branch**: `199-memory-class-access`
**Spec directory**: `specs/034-memory-class-access`
**Created**: 2026-06-04 · **Revised**: 2026-06-05
**Status**: Draft
**Input**: Design discussion [`memory/2026-06-04-memory-access-rules`](../../../hadron-concept/design-discussions/memory/2026-06-04-memory-access-rules/) — final [summary.md](../../../hadron-concept/design-discussions/memory/2026-06-04-memory-access-rules/summary.md) (decisions D-2026-06-04-001/002 + D-2026-06-05-001/002/003).

> Spec + all planning artifacts (`plan.md`, `research.md`, `data-model.md`,
> `contracts/`, `quickstart.md`) were rewritten 2026-06-05 to the final design and
> are the current, authoritative set for this feature.

## Context

The first external user created a portal memory expecting it to be private; an org
owner could read it and the creator couldn't write it. The memory was
`class='knowledge'`, which is **org-scoped and role-governed by design** — so that
behavior was correct *for the wrong class*. A band-aid that put owner semantics on
`knowledge` via `createdBy` was reverted (`createdBy` is provenance, not
authorization). The fix is to make a **user-owned, owner-only memory** a real,
usable thing, and to remove the `visibility`/`type` drift that made "private"
ambiguous. Access is driven by the existing **`Memory.class`**; no new field, no
groups (group memory is a documented future layer).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A user owns an owner-only memory, anywhere (Priority: P1)

A signed-in user creates a **private** (or **personal**) memory and is its sole
reader/writer — regardless of org role, and **whether or not it is tied to an
app**. No other org member, org admin, or platform admin can read or write it.

**Why first**: it's the unmet need behind the incident, and it's the portability
goal — a memory a user truly owns.

**Independent Test**: as user A (an org READER, no active app), create a `private`
memory; A reads/writes its nodes; user B, an org ADMIN, and a platform OWNER are
all denied on every read, write, list, open, and search surface.

**Acceptance Scenarios**:

1. **Given** A is a READER (or has no org at all), **When** A creates a `private`
   or `personal` memory **with no app**, **Then** it is owned by A (`userId=A`,
   `app_id=NULL`) and A can add/edit/delete its nodes.
2. **Given** A's owner-only memory, **When** any other user — including org ADMIN
   and platform OWNER — reads it, lists, opens, or searches, **Then** it never
   appears and direct access is denied.
3. **Given** a `private` memory, **When** anyone attempts to share it, **Then** the
   attempt is rejected (private is never shareable).
4. **Given** a `personal` memory, **When** the owner shares it with another user
   via `MemoryShare(writer)` and later revokes, **Then** the grantee can
   read/write while the row exists and loses access immediately on revoke.
5. **Given** a `personal`/`private` memory **inside an app** (`(app, user)` scope),
   **When** the same user uses a *different* app, **Then** that memory is not
   reachable (per-app isolation).

### User Story 2 — Class governs access; knowledge stays org-shared (no regression) (Priority: P1)

Each memory's access follows its `class`: `system` (members read), `app` (members
read/write), `knowledge` (read per `visibility` = organization-wide or public;
members write), `personal`/`private` (owner-only). Org/app members and admins keep
their existing access to shared classes.

**Independent Test**: an org ADMIN reads/writes org `knowledge`; an app member
reads/writes the app's `app` memory and reads `system`; none of them reach another
user's `personal`/`private`.

**Acceptance Scenarios**:

1. **Given** a `knowledge` memory with `visibility=ORGANIZATION`, **When** an org
   member reads it, **Then** allowed; **When** `visibility=PUBLIC`, **Then** any
   caller (incl. unauthenticated) may read it.
2. **Given** an `app` memory, **When** an app member reads/writes, **Then** allowed;
   **Given** a `system` memory, **When** an app member writes, **Then** denied
   (read allowed).

### User Story 3 — `visibility`/`type` cleanup (Priority: P2)

`MemoryVisibility` no longer carries `PERSONAL`/`PRIVATE`; it is nullable and used
only by `knowledge` (PUBLIC/ORGANIZATION) and `group` (GROUP). `Memory.type` is
removed; system memories are identified by `class=system`.

**Independent Test**: schema/constraints reject a `personal` row with a non-null
visibility; `Memory.type` no longer exists; the full suite is green.

**Acceptance Scenarios**:

1. **Given** the pruned enum, **When** a memory is `class IN (system, app, personal,
   private)`, **Then** its `visibility` is NULL; **When** `class=knowledge`, **Then**
   `visibility ∈ {PUBLIC, ORGANIZATION}`; **When** `class=group`, **Then**
   `visibility=GROUP`.
2. **Given** the codebase, **When** `Memory.type` is removed, **Then** every former
   `type` read uses `class` with no behavior change.

### Edge Cases

- A user with **no organization** creates a `private`/`personal` memory — works
  (owner-only; needs no org). `organizationId` may be NULL.
- A `private` memory's owner is deleted — it must not become readable by others
  (fail-closed; ownership transfer is out of scope).
- Attempting to set `class` to/from `private`, or to transfer a
  `private`/`personal` owner — rejected (immutable owner/class in v1).
- A `private` memory opts into encryption — accepted as a flag; the actual
  encryption is out of scope (may be surfaced as "coming soon").
- Publishing a `knowledge` memory `PUBLIC` — a deliberate, effectively one-way
  action exposing an unauthenticated read path; must be explicit, never default.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Authorization MUST be determined by `Memory.class` (+ owner +
  app/org membership + `MemoryShare`). `createdBy` MUST NOT be used as an
  authorization input anywhere.
- **FR-002**: `Memory` ownership MUST support a **user** owner, not only an
  organization. This is expressed via the **existing** typed columns — `userId`
  (the user owner, for `personal`/`private`) and `organizationId` (the org), which
  MUST be made **nullable** — plus the existing agent/app linkage
  (`Agent.systemMemoryId` for `system`, `app_id` for `app`). **No new generic or
  polymorphic owner column is introduced** (a dedicated `ownerAgentId`/`ownerAppId`
  column set is explicitly out of v1 scope). A row's owner is determined by its
  `class` together with these existing columns.
- **FR-003**: `personal` and `private` memories MUST be readable and writable
  **only by their owner** (`userId`) — no org-membership path, no ADMIN/OWNER
  bypass.
- **FR-004**: `personal`/`private` memories MUST be creatable **free-standing**
  (no `app_id`, no agent, no agent subscription); the `(app, user)` form (with
  `app_id`) MUST also be supported.
- **FR-005**: `private` MUST never be shareable; `personal` MUST be shareable
  **only** via the existing `MemoryShare` (`reader|writer`). Revocation (row
  delete) MUST take effect immediately.
- **FR-006**: `private` MUST be the only class that may set `encrypted=true`
  (opt-in; default false). The user-facing surface MUST NOT imply that
  "private ⇒ encrypted." *(Encryption implementation is out of scope.)*
- **FR-007**: `knowledge` access MUST follow `visibility`: `ORGANIZATION` (org
  members read) or `PUBLIC` (any caller, including unauthenticated, reads); members
  may write. `app` MUST be app-member read/write; `system` MUST be app-member read,
  builder (agent owner) write.
- **FR-008**: The platform MUST provide a user-facing `createMemory` path for
  `private` and `personal` (owner = the creating user), including the free-standing
  (no-app) form.
- **FR-009**: `MemoryVisibility` MUST be reduced to `{PUBLIC, ORGANIZATION, GROUP}`
  and made **nullable**. `PERSONAL` and `PRIVATE` values MUST be removed.
  `visibility` MUST be non-null only for `class IN {knowledge, group}`.
- **FR-010**: `Memory.type` MUST be removed; everything that distinguished system
  memories by `type` MUST use `class=system`, with no behavior change.
- **FR-011**: The ownership/shape CHECK constraints MUST be re-keyed onto `class`:
  `class=personal ⇒ userId NOT NULL`; `class=private ⇒ userId NOT NULL`;
  `class=group ⇔ visibility=GROUP` (unchanged); `visibility` non-null only for
  `class IN {knowledge, group}`; and `chk_memory_class_app_id` relaxed to
  **`class=app ⇒ app_id NOT NULL`** (so `personal`/`private` no longer require
  `app_id`).
- **FR-012**: Active-app scoping MUST be a **restriction only**: with no active
  app the caller sees/uses the widest set they may access; an active app **masks
  that set down** to the app's memories. Activating an app MUST NOT widen access or
  change how any access decision resolves.
- **FR-013**: No new access entities are introduced. `Group`, `AssignedGroup`,
  `MemoryAccess`, and a `Memory.role` field MUST NOT be added (group memory is a
  deferred future layer).

### Key Entities

- **Memory** — governed by `class ∈ {system, app, knowledge, personal, group,
  private}` (the access axis). Typed one-of owner. `visibility` nullable
  `{PUBLIC, ORGANIZATION, GROUP}`, used only by `knowledge`/`group`. `encrypted`
  bool (only `private`). `app_id` required only for `class=app`. `type` removed.
  `createdBy` is provenance, never authz.
- **MemoryShare** (existing) — `(memoryId, granteeId, grantorId, role:
  reader|writer)`; `personal` only; revoke = row delete.

## Success Criteria *(mandatory)*

- **SC-001**: A user can create a `private`/`personal` memory (incl. free-standing,
  no app) and be its sole reader/writer: 100% of non-owner access attempts (peer,
  org ADMIN, platform OWNER) denied across read/write/list/open/search.
- **SC-002**: The creator — even an org READER, or a user with no org — can write
  their own owner-only memory: 0% false-deny.
- **SC-003**: No regression for `knowledge`/`app`/`system`: existing access-control
  suite stays green; `PUBLIC` knowledge is readable unauthenticated; `ORGANIZATION`
  is org-only.
- **SC-004**: `MemoryVisibility` has exactly `{PUBLIC, ORGANIZATION, GROUP}` and is
  NULL for `class ∉ {knowledge, group}`; the re-keyed CHECKs hold; `personal`/
  `private` rows can exist with `app_id NULL`.
- **SC-005**: `Memory.type` no longer exists; full suite green (system handling is
  class-derived).
- **SC-006**: Sharing/revocation on `personal` via `MemoryShare` grants and removes
  access immediately; `private` share attempts are rejected 100%.

## Assumptions

- The MVP cohort is small; existing rows are reconfigured by hand (no audited data
  migration). Removing enum values is a Postgres type-swap migration (new type +
  column swap), mapping existing `PERSONAL`/`PRIVATE` → NULL by class.
- `personal` default scope is `(app, user)` when created inside an app;
  free-standing personal/private are user-owned with `app_id NULL`.
- The canonical predicate `src/lib/auth/resolveMemoryAuthorization.ts` today gates
  `personal`/`private` to the owner **but also** requires agent-scoping
  (`userMemoryOfAgentId`, and `app_id` for `personal`) and an `AgentSubscription`
  license check, and it honors `MemoryShare` for `personal`. This feature **removes
  the agent-scoping + `AgentSubscription` requirement** for `personal`/`private` so
  a **free-standing** (app-less, user-owned) memory resolves as owner-only;
  `MemoryShare(personal)` is retained, `private` stays non-shareable.

## Out of Scope

- Encryption-at-rest **implementation** and key custody. Deferred.
- Group memory / the `owner + groups + rwa` ACL layer (`Group`/`MemoryAccess`),
  intra-app role differentiation, read-only-for-some shared memory
  (Q-2026-05-25-003), per-memory access tuning. Deferred — documented future layer.
- Owner **transfer** for `personal`/`private`. Out of v1.
- Lifecycle / cascading deletion / orphaning. Its own discussion.

## Dependencies

- Revises `spec-kits/specs/024-memory-config` (the `private` class + visibility
  CHECK pattern); supersedes its `encryptAtRest` class-lock (now opt-in) and its
  `PERSONAL`/`PRIVATE` visibility values (now removed).
