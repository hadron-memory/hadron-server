# 048 — Retire the auto-personal ("shadow") organization

Status: **planned** (2026-07-24, Holger + Claude). Precedent: **spec 047**
(user-owned tenancy — the enabling work, shipped) and the hadron-server half of
the **#627** individual-user epic (this is that half). Portal slice 1 of #627
(PR #632, org-less "My memories") already shipped.

## Problem

Every new user is provisioned an **invisible personal organization** at signup
(`provisionPersonalWorkspace`, `src/provisioning/personal-workspace.ts`), which
scaffolds a bundle: a hidden `Organization` (`isVisible: false`), an OWNER
`OrgMember`, a default `"My Agent"` agent, a `"My Workstation"` App + `AppKey`,
and a `PendingSetup` row so the raw `hdr_app_…` key can be shown once via
`/setup/info`.

The **only** reason this shadow org exists is historical: memory / agent / App
ownership used to require an `organizationId`. **Spec 047 removed that
dependency and is shipped** — `Memory`, `Agent`, and `App` all carry
`ownerUserId` with an `organizationId`-XOR-`ownerUserId` CHECK, and
`createMemory` / `createAgent` / `createApp` all accept the org-less user-owned
path (`resolvers.mutation.{memory,agent,app}.ts`), with `effectiveAccess` and
MCP access-control owner branches in place. The substrate the shadow org
provided is now a first-class feature, so the shadow org is pure legacy
scaffolding — and a leaky one: spec 047 explicitly **rejected** it as a durable
personal namespace (clicking "Create Organization" *converts* the personal org
into the named company org via the `isVisible` flip, destroying the substrate).

## Goal

1. **New users get no org and no auto-provisioned workspace.** Signup creates
   the `User` (+ its pool principal) and nothing else. A user creates their
   first user-owned agent / App / key explicitly, when they want one.
2. **The 12 existing personal orgs are migrated to user-owned** and deleted, so
   prod ends with **zero** invisible personal orgs and the personal-org-as-
   substrate machinery can be retired.

## Operating assumption (why this can be a hard cutover)

Holger controls invitations and **will not onboard any new user while this is in
flight** (confirmed 2026-07-24). Therefore:

- **No dual-path / feature-flag / gradual rollout.** Rip out the old provisioning
  wholesale; `isNew` and the new-user redirect need not stay continuously
  correct during development.
- **The personal-org set is frozen at exactly 12.** The migration is a one-shot
  script over a static set — no race with a concurrent signup.

If that quiet window can't hold, this plan's cutover assumptions break and it
must be re-scoped as a phased, backward-compatible change.

## Decisions (2026-07-24, Holger)

1. **Lazy provisioning.** Provision **nothing** at signup (not "re-home the
   bundle to user-owned"). The default agent / App / key are created on demand
   via an **explicit** action, never auto-conjured on first use (murky
   triggers). CLI users already have `pnpm admin:mint-token` for a first
   user-scoped token.
2. **Full scope.** Migrate + delete the 12 existing personal orgs in the same
   effort; end state has no personal orgs.
3. **`isNew` is derived from user creation, not workspace existence.** Today
   `isNew = !hasPersonalWorkspace(...)`; with nothing provisioned that is always
   true. Each auth flow already does a create-or-find of the `User`; `isNew`
   becomes "this callback created the user row."

## Server touchpoints (Phase A — stop provisioning)

- **Four auth flows** call `provisionPersonalWorkspace` + `hasPersonalWorkspace`:
  GitHub (`src/server.ts:316`), Google (`:495`), Apple (`:664`), email
  magic-link (`:813`). Remove the provisioning block from each.
- **`isNew` rewire.** GitHub already has an `existing` vs. created split
  (`:264`); `resolveGoogleUser` (`:491`) / `resolveAppleUser` (`:659`) and the
  email upsert (`:798`) return a user without a "created" flag — thread a
  `created` boolean out of each resolver (or compare `User.createdAt`) so `isNew`
  is honest. `isNew` still drives `redirect: isNew ? '/app/setup' : …` and is
  returned to the client (`:389/:538/:707/:835/:888`).
- **New-user redirect.** `'/app/setup'` currently lands on the PendingSetup /
  `/setup/info` raw-key reveal. With nothing provisioned there is no key —
  repoint new users at the org-less landing (the PR-632 "My memories" surface)
  with an explicit **"Create your first agent / App key"** affordance. (Portal
  work — see Phase C.)
- **Dead code to remove:** `provisionPersonalWorkspace`,
  `reactivatePersonalWorkspace`, `hasPersonalWorkspace`
  (`src/provisioning/personal-workspace.ts` + its test), the `/setup/info`
  endpoint (`src/server.ts:923`), and the `PendingSetup` writes. Decide whether
  to drop the `PendingSetup` model itself (a later migration) or leave the table
  orphaned for now.

## Migration (Phase B — retire the 12 existing personal orgs)

A one-shot, idempotent script (`scripts/…`, runnable against prod per the
alpha DB-access runbook). For each org where `isVisible !== true` and it is a
personal workspace (created-by == sole OWNER member; verify the shape before
touching):

1. **Re-home entities** from `organizationId` → `ownerUserId = <the owner>`,
   flipping `organizationId` to NULL in the **same** statement to satisfy each
   `chk_<entity>_owner_xor`: `Agent`, `App` (its `AppKey` / `AppAgent` ride the
   App id, unchanged), and every `Memory` owned by the org (the default agent's
   `class='system'` memory, plus any the user added).
2. **Re-root URNs** from the org namespace (`<org.urn>:<slug>`) to the owner's
   BARE-handle namespace (`<handle>:<slug>` — #697 v2 dropped the `@` sigil; a
   single colon separates a colon-free root atom from the slug). Model this on
   **`mergeOwnerNamespacedUrns`**, NOT `renameOwnerNamespacedUrns` — see the
   "URN re-rooting" section below for why. Node/Edge URNs are composed on read
   from the memory URN + loc (no stored `Node.urn`), so they self-heal once the
   parent memory URN moves; record each row's pre-migration URN in `legacyUrn` so
   lingering textual refs still resolve; rewrite the durable `entry_node_urn`
   refs (`agent_schedules` / `agent_webhooks` / `webfetch_poll_bindings`) via the
   old→new remap. Every user has a NON-NULL handle post-047, so the target root
   always exists.
3. **Re-home any personal `ExchangeConnection`** anchored to the org (047 made
   `organizationId` nullable; Slack stays org-anchored — leave those).
4. **Delete** the now-empty `Organization`, its `OrgMember`, its pool principal
   (`ensureOrgPrincipal` counterpart), and any `PendingSetup` rows.
5. App-scoped runtime state (`Session`, `UsageEvent`, `AppLogEntry`, …) keys off
   the App id, which is unchanged — verify nothing keys off `organizationId`
   directly.

Guardrails: dry-run mode that reports the plan per org; wrap each org's
migration in a transaction; assert the XOR CHECK holds after; refuse to run if
any candidate org has >1 member or non-personal shape (fail loud for manual
review).

### URN re-rooting (the migration's core — resolved)

Both existing helpers were read (`src/lib/ownerUrnRename.ts`,
`src/lib/mergeOwnerNamespacedUrns.ts`). Conclusion: **fork the merge helper's
shape; do NOT reuse `renameOwnerNamespacedUrns`.**

- **`renameOwnerNamespacedUrns` is the wrong tool.** Its `urn` rewrites are
  FK-scoped by `owner_user_id` (our source rows are org-owned — `ownerUserId`
  NULL — so it wouldn't match them until we re-home first), and, decisively, it
  **fail-closes the whole transaction on any live `urn` collision** (agent/memory
  `urn` is globally unique). The default workspace slugs (`my-agent`,
  `my-workstation`, the agent's system-memory slug) make a collision *plausible*
  for any of the 12 owners who ALSO created a user-owned entity via the 047
  org-less path — so a fail-closed rewrite is a landmine, not a safety net.
- **`mergeOwnerNamespacedUrns` is the right template.** It already does exactly
  the hard part: re-root owner-namespaced App/Agent/Memory onto a target root
  using `mintLocalSlug` to **re-mint a colliding slug** (`my-agent` →
  `my-agent-<disambig>`) instead of aborting, record `legacyUrn` for old-ref
  resolution, surgically reclaim only the exact-URN soft-deleted holder (never a
  namespace-wide delete), and rewrite `entry_node_urn` via a precise full-URN
  old→new remap (correct even under a re-mint). `slugOf()` strips "everything up
  to the first colon", which handles our single-atom org roots (`<handle>-org`,
  `personal-<userId>`) correctly.
- **What the migration sibling must change vs. merge:** (a) select source rows by
  `organizationId = <org>` (merge selects `ownerUserId = source`); (b) set
  `owner_user_id = <owner>` **and** `organization_id = NULL` in the re-home
  (merge only moves `owner_user_id`, since both sides are already user-owned) —
  satisfying `chk_<entity>_owner_xor`; (c) seed the `mintLocalSlug` disambiguator
  from the org root (or a fixed `-personal` seed) rather than a `sourceHandle`.
  `AppKey` / `AppAgent` ride the App id (not URN-bearing) — untouched.

### Two schema findings (Phase B implementation, 2026-07-24)

1. **Org-less connections are NOT shipped.** `ExchangeConnection.organizationId`
   is still `String` **non-null** with `onDelete: Cascade` (spec 047 Phase 5
   didn't land). So a personal connection can't be re-homed org-less, and an
   org-delete would cascade it away. Rather than block Phase B on Phase 5, the
   migration **refuses** (skips + reports) any org with a live connection.
2. **An org-delete cascades into 14 tables.** Re-homing Agent/App/Memory (null
   `organizationId` first) is safe, but the `DELETE organization` itself
   cascades everything else keyed to the org. Benign after a scaffold delete:
   `org_members` (the sole row) + `usage_events` (SetNull). Destructive if
   present: `exchange_connections`, `slack_connections`, `mcp_servers`,
   `home_assistant_instances`, `resend_senders`, `credit_ledger_entries`,
   `memory_subscriptions`, `agent_org_grants` (col `org_id`, not
   `organization_id`), `principal_grants`, `ai_service_configs`.

**Guardrail (Holger, 2026-07-24): refuse-and-report.** The migration re-homes
only clean scaffold orgs and SKIPS any org with a non-single-OWNER shape, an
owner with no URN-legal handle, or any row in those destructive tables — never a
silent cascade-delete. A dev-DB dry-run confirmed both branches fire on real data
(a `createdBy` mismatch and an `agent_org_grants: 2` org were correctly skipped),
and that some personal orgs DO carry a `my-agent-system` memory (re-rooted fine).
Implementation: `src/lib/personalOrgRetirement/retirePersonalOrgs.ts` +
`scripts/retire-personal-orgs.ts` (`pnpm admin:retire-personal-orgs`, dry-run by
default; `--apply` to write).

### Pre-migration collision audit

Before running Phase B, query the 12 owners for any existing user-owned entity
whose re-rooted `<handle>:<slug>` would collide with a shadow entity (per-owner:
does `<handle>:my-agent` / `<handle>:my-workstation` / the system-memory slug
already exist as a live user-owned row?). The merge-style re-mint handles
collisions gracefully regardless, so this audit is **informational** — it tells
us how many entities will land on a `-suffix` alias, which is a UX note (the
user's migrated "My Agent" may resolve at `<handle>:my-agent-personal`), not a
blocker.

## Cleanup (Phase D — retire the substrate semantics + drop `isVisible`)

Once prod has zero personal orgs, **the `isVisible` column is deleted.** Its only
`false` case was the unactivated personal shadow org; with those gone every org
is activated by definition, so the column is vestigial. The genuinely-remaining
axis — "does this org opt into public / marketplace discovery" — is already
`listedOnMarketplace`. The listing model collapses to: **all orgs are listable to
members and platform admins / global search; public + marketplace discovery is
governed by `listedOnMarketplace` (+ public resources).**

- **Drop `Organization.isVisible`** (schema + a migration that runs *after* the
  Phase-B deletion of the 12 personal orgs — they are the only `isVisible=false`
  rows). Also drop the `Memory.listedOnMarketplace`-adjacent `isVisible`
  precondition references, not the marketplace columns themselves.
- **Rewire the consumers** (all currently gate on `isVisible === true` as the
  activation flag):
  - `src/lib/orgDiscoverability.ts` — remove the `isVisible: true` precondition;
    discoverability = `hasPublicResources` OR `listedOnMarketplace`.
  - `src/lib/global-search/entities.ts:197` — drop the `isVisible: true` branch
    (all orgs listable; keep any member-scoping that isn't about activation).
  - `src/api/graphql/schema/resolvers.query.org.ts` — the org-list gate (`:331`),
    the admin `ref` gate (`:378-380`), and the marketplace queries (`:416`,
    `:438`, `:460`) drop their `isVisible` clauses.
  - `src/api/graphql/schema/resolvers.mutation.org.ts` — `createOrganization`
    stops setting `isVisible: true` (`:217`); `updateOrganization` drops the
    `isVisible` arg (`:239/:271`).
  - `typeDefs.ts` — remove the `Organization.isVisible` field (`:1274`), the
    `updateOrganization(isVisible:)` arg (`:4119`), and the isVisible mentions in
    the discoverability/marketplace descriptions.
- Remove the personal-org-specific `organization: { isVisible: { not: true } }`
  reads (in `/setup/info` and `resolvers.mutation.memory.ts:1459`) — these go
  with Phase A / the personal-org deletion. **Consumer mode becomes "user has
  zero orgs,"** not "user has one invisible org."
- **Spec / convention updates** (loc-as-citation — supersede, don't renumber; see
  the `add-spec` skill): retire `cor:acl:080:01` (the `isVisible` activation
  rule) and rewrite the `cor:acl:080` discoverability model around
  `listedOnMarketplace`; retire `conventions:personal-org-marker` entirely (it is
  wholly about `isVisible=false`); update `cor:dmo:010:03` / `cor:dmo:040:01`,
  which still describe an "auto-created invisible personal organization."

## Authorization (first-class review criteria)

- User-owned Agent/App/Memory is **owner-only** (no membership, no ADMIN bypass)
  — the migrated entities must land on that gate. Reuse the shared memory-access
  gate; keep portal + MCP in parity (do not hand-roll). Confirm `App.keys` /
  `App.members` don't leak for a now-user-owned App (#552 class).
- A zero-workspace user must **degrade gracefully** — anything assuming every
  user has an active App/agent (MCP active-app resolution, run defaults) shows an
  empty state, never throws.

## Phases

- **A — stop provisioning** (this repo): strip the four call sites, rewire
  `isNew`, delete dead provisioning code, retire `/setup/info`.
- **B — migration script** (this repo): re-home + delete the 12 orgs; dry-run
  first, run against prod in the quiet window.
- **C — portal** (hadron-portal, #628/#629): zero-org nav + dashboard empty
  states; new-user landing + "create your first agent/App key" CTA. Slice 1
  (#632) already did the memories surface.
- **D — cleanup** (this repo): retire personal-org-substrate reads; update the
  affected spec/convention nodes.

## Testing

- Auth-flow tests: a brand-new signup on each of the four providers creates the
  `User` + principal and **no** org/agent/App/`PendingSetup`; `isNew` is true on
  first callback, false on the second.
- Returning-user signup is unaffected.
- Migration script test: seed a personal-org-shaped fixture, run, assert the
  entities are user-owned with rewritten URNs, the org/member/principal are
  gone, and the XOR CHECK holds; idempotent on re-run; refuses a malformed
  candidate.
- A zero-workspace user can create a user-owned agent + App + key end-to-end and
  read/write their own memory (MCP + GraphQL parity).

## Out of scope

- Members/sharing on user-owned Apps/Agents (spec 047 out-of-scope, still).
- The `listedOnMarketplace` columns and the marketplace model itself (unchanged;
  they become the *sole* discovery axis once `isVisible` is dropped).
- Any change to org-owned (company) workspaces beyond dropping the vestigial
  `isVisible` activation state.

## Open questions

1. **`isNew` source** — thread a `created` flag out of each resolver, or lean on
   `User.createdAt` recency? Threading is exact; `createdAt` is simpler but
   fuzzy across a slow callback. (Lean: thread the flag.)
2. **`PendingSetup` model** — drop the table now or leave it orphaned until a
   later cleanup migration?
3. **Org→handle URN re-rooting** — RESOLVED (see "URN re-rooting" above): fork
   the collision-safe `mergeOwnerNamespacedUrns` shape into a migration sibling
   that selects by `organizationId` and sets the XOR owner columns; do NOT reuse
   `renameOwnerNamespacedUrns` (FK-scoped + fail-closes on the plausible
   default-slug collision). Remaining sub-question: seed the collision
   disambiguator from the org root or a fixed `-personal` suffix? (Lean:
   `-personal` — a stable, readable alias.)
4. **Explicit "create first workspace" affordance** — portal CTA wording/shape
   is a #628/#629 detail; does the server need a convenience mutation that
   bundles agent+App+key, or is the portal composing the existing three
   mutations enough? (Lean: compose existing; no new server surface.)
