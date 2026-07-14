# 047 — User-owned tenancy: Apps, Agents, Memories + mailbox connections

Status: **planned** (design converged 2026-07-13, Holger + Claude). Precedent:
spec 034 (free-standing personal memory), spec 042/#593 (`ConnectionGrant`).
This spec removes the hard dependency of Apps, Agents, and Memories on an
Organization, so an individual is a first-class owner of them with no org at
all — and makes mailbox/calendar connections user-ownable to match.

## Problem

A user who wants a personal agent (e.g. a Gmail assistant) can't have one:

1. **Apps, Agents, and Memories are org-only.** All three require
   `organizationId` and derive their URN from `org.urn + ":" + slug`
   (`prisma/schema.prisma` — App `:2227`/`:2212`, Agent `:1263`/`:1265`, Memory
   `:543`/`:567`). None can exist without an organization.
2. **Mailbox connections are org-anchored.** `ExchangeConnection.organizationId`
   is non-null (`:1875`) and connecting gates on **org ADMIN** (#506,
   `src/integrations/mailboxConnect.ts:100`, `:203`).

**Why the invisible-personal-org can't paper over this** (the design trap): the
auto-personal org (`Organization.isVisible !== true`, `:435`) is **not durable**
as a personal namespace — a user who clicks "Create Organization" *converts their
personal org into their named company org* (`:435`–`442`). Relying on it means a
later "for myself" action forces a *second* org. So the fix is to decouple from
Organization, not to hide behind the invisible one.

## Goal

Apps, Agents, and Memories can be owned by **an organization OR an individual
user**; a user can connect **their own** mailbox/calendar with no org and no
admin gate. Cross-cutting mechanism: a single **owner namespace** in the URN
grammar and a uniform `organizationId`-XOR-`ownerUserId` ownership shape.

## Decisions (2026-07-13, Holger)

1. **Uniform user-or-org ownership for App, Agent, Memory.** Each gains
   `ownerUserId`, `organizationId` becomes nullable, and a CHECK enforces XOR
   (exactly one owner). No reliance on the auto-personal org.
2. **One owner-namespace URN grammar for all three.** The first URN segment
   generalizes from *org domain* to *owner namespace*: an org domain
   (`micromentor.org`) or a **user handle** rendered `@<handle>` (`@holger`).
   The `::<slug>` two-segment shape is preserved so `composeInstalledAgentUrn`
   (`src/lib/urn.ts:1151`) and the app-user/anon memory URNs keep parsing. `@`
   can't begin a domain, so it disambiguates the two namespaces.
3. **`User.handle` becomes NON-NULL** (`prisma/schema.prisma:334`, currently
   `String? @unique`). Generated at user creation from a readable seed (OAuth
   login → display name → email local-part); on collision or when no seed is
   usable (Apple private-relay + hidden name), it appends a **random** token or
   emits a bare random handle — **never a sequential suffix** (a `-2`/`-7`
   ladder is an enumeration oracle exposing signup order / user count).
   User-editable later. **Holger backfills existing production users** before
   the NOT-NULL migration. The `@<handle>` namespace depends on every user
   having one. Implemented in `src/lib/userHandle.ts` (`generateUniqueHandle`),
   wired into every `user.create` path. **App end-users** (`identityProvider=
   'APP'` — `createAppUser`, implicit-session auto-provision, magic-link) get a
   **random** handle (an explicit `createAppUser` `handle` arg is honored);
   they're keyed by `(externalAppId, externalId)` and aren't the `@handle`-owner
   persona, so they're deliberately **not** seeded from name/email/externalId
   (no app PII leaks into a global handle).
   **Handle rename re-addresses URNs**: because a user-owned App/Agent/Memory
   URN is `@<handle>::<slug>`, renaming a handle must propagate to those child
   URNs — the same mechanism as `propagateOrgUrnRename` (org URN → children).
   Not a big challenge, but a required Phase-1/2 follow-up.
4. **User-owned Agents force user-owned Memories.** `createAgent` auto-provisions
   the agent's `class='system'` memory (#518); a user-owned agent's system (and
   any knowledge) memory is owned by the same user. This is why Memory is in
   scope, not a fast-follow.
5. **Personal mailbox connections are org-less.**
   `ExchangeConnection.organizationId` becomes nullable; personal =
   `organizationId NULL`, owner = `userId`. **Mail + personal calendar only**
   (`gmail`/`ms-exchange`/`google-cal`); **Slack stays org-anchored** (a
   workspace is a team resource; `ExchangeConnection` is the shared row, so the
   gate keys off provider).
6. **Personal Apps are owner-only in v1** — no members besides the owner.
   Sharing a user-owned App is a later spec.
7. **Roll in #653 — `knowledge` and `group` memories may attach to an App.**
   Co-located, not conflated: it's a distinct capability (app-scoping of shared
   memory classes) but it edits the **same `chk_memory_class_app_id` constraint**
   that decision 1's Memory ownership work already reopens, and that constraint
   has bitten prod before (a 2026-05-19 migration exists because a prior `ALTER`
   never took effect). One coherent migration pass beats two rounds of surgery on
   the same ~4-copy-synced CHECK. Splittable if review balloons.

## Owner-namespace URN grammar

| Owner | Namespace token | Example URNs |
|---|---|---|
| Organization | `<org-domain>` | `urn:app:micromentor.org::gmail-app` (unchanged) |
| User | `@<handle>` | `urn:app:@holger::gmail-app`, `urn:agent:@holger::inbox-triage`, `urn:memory:@holger::inbox-triage` |

- The parser (`src/lib/urn.ts`) accepts `@<handle>` in the namespace slot for
  `app`, `agent`, and `memory` types (and the app-user / anon memory forms
  derived from an agent URN). The two-segment `namespace::slug` invariant is
  untouched.
- **Cross-repo parser parity** (feedback: parser copies drift — #239): the
  grammar change lands in every parser copy (server `src/lib/urn.ts`, portal,
  docs, cli) + the golden-set fixtures
  (`src/lib/__fixtures__/parser-golden-set.json` and siblings). Track a checklist
  so no copy is missed.

## Data model — uniform shape

For **App** (`:2204`), **Agent** (`:1260`), **Memory** (`:540`):
- `organizationId String?` — nullable; `ownerUserId String? @map("owner_user_id")`
  + `@@index`; `ownerUser` relation added, `organization` made optional.
- CHECK `chk_<entity>_owner_xor`: `(organization_id IS NULL) <> (owner_user_id
  IS NULL)`. Hand-SQL in the migration + `post-push.sql` (Prisma can't model it),
  following the inline-constraint-synchronization discipline (the memory CHECKs
  already live in ~4 places — keep them in sync).
- URN uniqueness indexes unchanged in shape; a `@<handle>::…` URN slots in.

**Memory specifics** (`:540`): `ownerUserId` is the **tenant owner**, distinct
from the existing `userId` **strict personal-owner** (CHECK-tied to
`class IN ('personal','private')`, no admin bypass — cor:acl:010:02). They
coexist:
- Org system/knowledge memory: `organizationId` set, `ownerUserId` null, `userId` null.
- **User-owned agent's** system/knowledge memory: `organizationId` null,
  `ownerUserId` = the user, `userId` null (class=system/knowledge — read per
  class rules, NOT strict-owner).
- Free-standing personal memory: `organizationId` null, `ownerUserId` = user,
  `userId` = same user (strict owner). Existing personal-memory semantics
  unchanged; it simply gains a real org-less tenancy.
- The class↔owner CHECKs (`chk_personal_visibility_user`, `chk_memory_class_app_id`)
  get a companion rule: a non-personal/private memory with no org must have
  `ownerUserId` (its tenant). Audit all copies.

**`chk_memory_class_app_id` (#653)**: move `knowledge` and `group` from the
`app_id IS NULL` (forbidden) branch to the *optional* branch, so they may be
free-standing (App-less) **or** attached to an App; `system` stays app_id-
forbidden (an agent's own definition is never app-scoped). New form:

```
(class = 'app'  AND app_id IS NOT NULL)
OR (class IN ('personal','private','knowledge','group'))   -- app_id optional
OR (class = 'system' AND app_id IS NULL)
```

This stays a **separate** CHECK from the ownership XOR (orthogonal axes:
class×app_id vs owner). Update every synced copy (schema comments,
`post-push.sql`, migrations) in the one pass; never add it with IF-NOT-EXISTS.

**`ExchangeConnection`** (`:1873`): `organizationId String?` nullable; drop
`@@unique([organizationId, provider, mailboxEmail])`, add two partial indexes in
`post-push.sql` (`… WHERE organization_id IS NOT NULL` and
`(user_id, provider, mailbox_email) WHERE organization_id IS NULL`); replace the
org upsert (`mailboxConnect.ts:246`) with `findFirst({ userId, provider,
mailboxEmail, organizationId: null })` → create/update.

**Migration** is additive: existing org rows keep `organizationId`; the
Micromentor App/Agent/connection are untouched and keep working. The one
**breaking** step is `User.handle` NOT NULL (decision 3) — gated on Holger's
production backfill.

## Creation / install / license

- **`createAgent`**: accepts a user-owner target → `ownerUserId = caller`,
  `organizationId = NULL`, URN `@<handle>::<slug>`; the auto-provisioned system
  memory (#518) inherits the same user owner.
- **`installAgentIntoAppCore`** (`resolvers.helpers.ts:861`): user-owner target →
  App with `ownerUserId = caller`, URN `@<handle>::<slug>`. **No
  `AgentOrgGrant`** for a personal install (that grant licenses an agent to an
  *org*); it rides the owner's **`AgentSubscription`** (user→agent, already
  license-only — cor:dmo:030:01). Ownership is orthogonal to `Agent.visibility`
  (PUBLIC/ORGANIZATION/PERSONAL) and to subscriptions.
- `App.policy` inheritance from `Organization.policy` doesn't apply to a
  user-owned App (nullable already).

## Authorization surfaces (first-class review criteria)

A user-owned App/Agent/Memory/connection is **owner-only** — no membership
authorizes it, no ADMIN bypass. Every gate that assumes an org gains an
**owner-or-org** branch:

- **App/Agent read/list/resolve + `App.keys`/`App.members`**: where the gate is
  "member/admin of `.organizationId`," add "or `.ownerUserId === caller`." A
  user-owned entity must never leak keys/members/secrets to a non-owner and must
  never appear in an org-scoped listing (#552 nested-field-leak invariant).
  Audit `resolveAppRef`/`resolveAgentRef`, `resolveAppForRequest` (cor:acl:020),
  and the field resolvers.
- **Memory access** (`getAccessibleMemoryIds` / `memoryAccessFilter` /
  `getOrgReadableMemoryIds`): reuse the shared gate — a user-owned memory's
  tenant read path keys on `ownerUserId`, kept in parity across the portal and
  MCP gates (feedback: memory-read gates must stay in parity). Do NOT hand-roll a
  per-resolver owner check.
- **Connection org gates**: `resolvers.mutation.session.ts:571`
  (`requireOrgRole(ctx, connection.organizationId, 'ADMIN')`) → owner branch when
  org is NULL; audit `emailEvents.ts:64` consumers. **Slack unchanged**
  (`resolvers.*.slack.ts`) — never org-less; add a non-null-org guard.
- **Unchanged**: `requireEmailConnection` + `ConnectionGrant`
  (`resolvers.connectionGrant.ts`) — already owner-only, App-install-scoped.

## Connect flow (`src/integrations/mailboxConnect.ts`)

- Add `allowsPersonal` to the per-provider config (`gmail`, `google-cal` opt in;
  `slack` doesn't).
- `/auth/<provider>/start`: `orgId` omitted **and** `allowsPersonal` → skip
  `requireOrgRole`, mint nonce with `orgId = null`. `orgId` present → #506 gate
  unchanged. Slack + no `orgId` → 400.
- Callback (`:194`): personal nonce skips the `requireOrgRole` re-verify (only
  re-confirms the initiator exists); org nonce keeps the #506 re-check.

## app-user / anon memory under a user-owned App

Per-user app memory is `${org.urn}:${agentSlug}:app-user:${opaqueId}`
(`resolvers.mutation.memory.ts:1422`, `session.ts:198`); anon is `…:anon:…`
(`session.ts:238`). Under a user-owned App the namespace becomes `@<handle>:…`.
The opaque `app-user` indirection anonymizes *end-users within an org App*; a
personal App has a single human (the owner), so it's arguably vestigial there —
Phase 3 decides keep-uniform vs collapse-to-owner. The user's Gmail
**automations** live in personal memory under the App (`(app_id, user_id)`,
owner-only), auto-provisioned, run by the agent on the owner's behalf via the
subscription — no new work once the App is user-owned.

## Portal / UX

- **"Create/Install for myself vs for an organization"** — "myself" needs no org
  selection.
- **"Connect my Gmail"** → `/auth/gmail/start` with no `orgId` (prereq
  `GMAIL_CLIENT_ID`, else 503).
- User-owned Apps/Agents/Memories and personal connections render under a
  "Personal" heading, never under an organization.

## Phases

> **Slicing update (2026-07-13, discovered during Phase 2 slice 1).** The
> original Phase 2 bundled the ownership columns *with* making `organizationId`
> nullable. A blast-radius check showed nullable-org is **not** a standalone
> additive migration: ~179 `.organizationId` reads + ~60 `.organization.`
> accesses, most of them `requireOrgRole(ctx, x.organizationId, …)`, must become
> owner-or-org branches — i.e. nullable-org is **coupled with the Phase 3
> authz** work and ships with it. Also `Memory` already has a `userId`
> strict-owner (`UserMemoriesOwned`), so `ownerUserId` is a **second** user FK
> (tenant owner) needing distinct modeling. Re-sliced accordingly:
> - **2a (shipped, PR #660):** the #653 `chk_memory_class_app_id` relaxation
>   only — independent, zero-ripple, closes #653.
> - **2b:** additive `ownerUserId` columns + relations (no XOR yet).
> - **2c (= merges with Phase 3):** make `organizationId` nullable + XOR CHECK +
>   the owner-or-org authz branches + `createAgent` user-owner + `@<handle>` URN
>   composition, together (they can't be separated safely).

1. **Handle NOT NULL + URN grammar.** Generate handle at user creation; Holger
   backfills prod; flip `User.handle` NOT NULL. Parser accepts `@<handle>`
   namespace for app/agent/memory (server + golden set); cross-repo parser
   checklist (portal/docs/cli). Tests: user URN round-trips; `composeInstalledAgentUrn`
   parses it; org URNs unchanged.
2. **Ownership columns + memory CHECK surgery.** `organizationId` nullable +
   `ownerUserId` + XOR CHECK on App, Agent, Memory (+ companion class↔owner CHECK
   on Memory). **#653 in the same pass**: relax `chk_memory_class_app_id` so
   `knowledge`/`group` may carry `app_id`. `createAgent` user-owner target
   provisions a user-owned system memory. Tests: user-owned agent's system memory
   is user-owned; a `knowledge` memory attaches to an App and a `system` memory
   still can't; org path unchanged.
3. **Ownership authz + app-user memory.** Owner-or-org branch across App/Agent
   gates, `App.keys`/`members`, and the shared memory-access predicates
   (parity-checked). app-user namespace under a user App. Cross-tenant leak
   tests: a non-owner (incl. org ADMIN) can't read a user-owned entity's
   keys/members/secrets or see it in an org listing.
4. **Install + license.** User-owner target in `installAgentIntoAppCore`; a
   subscription licenses the install; no `AgentOrgGrant`. Test: install a foreign
   PUBLIC agent as a personal App; no org grant created.
5. **Connections.** `ExchangeConnection.organizationId` nullable + partial
   uniques; `allowsPersonal`; `/start` + callback branch; upsert →
   findFirst/create; session-resolver owner branch; Slack guards. Leak tests as
   before.
6. **Portal UX.** For-myself create/install, Connect-my-Gmail, "Personal"
   grouping.

## Open questions

- ~~**Handle default recipe**~~ — RESOLVED: OAuth login → name → email
  local-part, then a random token (never sequential). `generateUniqueHandle`.
- **app-user indirection** under a personal App: keep uniform or collapse to owner
  (Phase 3).
- **Convert** a personal App/Agent/connection to org-owned later, or is
  re-create/re-connect acceptable? (Lean: re-create fine for v1.)

## Out of scope

- Members/sharing on a user-owned App (owner-only in v1) or a user→user share of a
  user-owned Agent.
- Slack / any non-mail-non-calendar provider going org-less.
- Changes to `requireEmailConnection` / `ConnectionGrant` semantics.
- A user→agent grant entity beyond the existing `AgentSubscription`.
- Migrating existing org-owned entities to user-owned (they keep working).
