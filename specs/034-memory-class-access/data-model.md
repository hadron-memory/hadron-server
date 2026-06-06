# Data Model — Memory access rules (class-driven, user-ownable)

> Rewritten 2026-06-05 to the final design-discussion landing. `plan.md` /
> `research.md` / `contracts/` / `quickstart.md` are stale (earlier group-ACL
> model) — regenerate via `/speckit-plan`.

## `Memory` — field changes

| Field | Before | After |
|---|---|---|
| `class` | enum (incl. unreachable `private`) | unchanged; **the access axis**; `personal`/`private` creatable & free-standing |
| owner | `organizationId` NOT NULL; `userId` for personal | **typed one-of** `{ownerUserId, organizationId, ownerAgentId, ownerAppId}`; `organizationId` **nullable** |
| `userId` | owner for personal | owner for `personal` **and** `private`; the only owner-authz field |
| `visibility` | `{PUBLIC,PRIVATE,ORGANIZATION,PERSONAL,GROUP}` NOT NULL, default PRIVATE | `{PUBLIC, ORGANIZATION, GROUP}` **nullable**; non-null only for `knowledge`/`group` |
| `type` (`MemoryType`) | `{KNOWLEDGE, AGENT_SYSTEM}` | **removed** (derive `class=system`) |
| `app_id` | required for `app`/`personal`/`private` | required for **`app` only**; NULL-able for free-standing `personal`/`private` |
| `encrypted`/`isEncrypted` | per-memory | only `class=private` may be true (opt-in) |
| `createdBy` | provenance | provenance — **never authz** |

Enums:
- `MemoryClass { system, app, knowledge, personal, group, private }` — **unchanged.**
- `MemoryVisibility { PUBLIC, ORGANIZATION, GROUP }` — **`PERSONAL`, `PRIVATE` removed.**
- `MemoryType` — **deleted.**

## Access by class (the rule — no new field, no groups)

| class | read | write | `visibility` | owner | shareable | encrypt |
|---|---|---|---|---|---|---|
| `system` | app members | builder (agent owner) | — (NULL) | agent | no | no |
| `app` | app members | app members | — (NULL) | app | no | no |
| `knowledge` | `ORGANIZATION`→org members; `PUBLIC`→anyone (incl. unauth) | members | **PUBLIC\|ORGANIZATION** | org/agent | no | no |
| `personal` | owner (`userId`) | owner | — (NULL) | user | via `MemoryShare` | no |
| `private` | owner (`userId`) | owner | — (NULL) | user | **no** | **yes** |
| `group` | *(deferred)* | | GROUP | | | |

No ADMIN/OWNER bypass for `personal`/`private`. Active app **masks the result set
down** (restriction only; never widens).

## CHECK constraints (`prisma/post-push.sql`, per constitution S5)

Re-keyed from `visibility` to `class`:

- `chk_memory_personal_owner` — **`class=personal ⇒ userId IS NOT NULL`** (replaces
  `chk_personal_visibility_user`).
- `chk_memory_private_owner` — **`class=private ⇒ userId IS NOT NULL`** (new).
- `chk_memory_group_visibility` — `class=group ⇔ visibility=GROUP` (**unchanged**).
- `chk_memory_visibility_class` — **`visibility IS NOT NULL` only for
  `class IN (knowledge, group)`** (new).
- `chk_memory_class_app_id` — relaxed to **`class=app ⇒ app_id IS NOT NULL`**
  (drops the `personal`/`private` app_id requirement; keeps `system/knowledge/group`
  app-less).
- Owner one-of — exactly one of `{ownerUserId, organizationId, ownerAgentId,
  ownerAppId}` set (shape per class).

Each new/changed CHECK ships with a regression test (S5).

## Migration

1. Remove `Memory.type` + `MemoryType` (verify `type=AGENT_SYSTEM ⇔ class=system`
   first).
2. `MemoryVisibility` value removal = **new enum type + column swap** (Postgres
   can't `DROP VALUE`). Map existing rows: `class=personal/private` → `NULL`;
   leave `knowledge` `PUBLIC/ORGANIZATION`; `group` `GROUP`. Pre-existing
   `knowledge` rows defaulted to `PRIVATE` → set to `ORGANIZATION` (or hand-fix).
3. Make `organizationId` nullable; add typed owner columns + one-of CHECK.
4. Re-key the ownership CHECKs onto `class`; relax `app_id` CHECK.
5. Existing memories reconfigured **by hand** (small cohort; no audited migration).

## Entities

No new entities. Field-level changes on `Memory`, the re-keyed CHECKs, and the
predicate reshape (`resolveMemoryAuthorization` `personal`/`private` branch →
owner-only, drop the agent/`AgentSubscription` requirement). Sharing stays on the
existing **`MemoryShare`** (`personal` only; `private` rejected at create).
**Not built:** `Group`, `AssignedGroup`, `MemoryAccess`, `memberDefault`,
`Memory.role` — the documented future group-ACL layer.
