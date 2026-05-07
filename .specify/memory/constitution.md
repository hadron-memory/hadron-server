<!--
PARENT RE-RATIFICATION — 2026-05-07 (parent v1.2.0 → v1.3.0)

The Hadron-wide parent constitution was amended via spec-kits PR
#27 (commit 35246dbd) to formalize the fifth nodeType `abstract`
in Invariant 2. This is corrective — `abstract` was already in
active use server-side (`src/api/graphql/schema/resolvers.ts:4234`,
the chat-summarization path) and documented in hadron-docs; the
parent amendment regularized the constitutional record to match.

Server-local impact: none. The server constitution's refinements
(Principle I/II/III/V) and server-only invariants (S1–S6) do not
restate parent Invariant 2; the parent's nodeType enumeration is
inherited unchanged. Re-ratifying this document at v1.0.0 with
the new parent pin (v1.3.0 + new SHA) per the parent-sync clause
in the Inheritance section.

No version change to this document. No content change beyond the
parent pin update.

————————————————————————————————————————————————————————————————

SYNC IMPACT REPORT — initial ratification → 1.0.0

This is the first hadron-server-local constitution. It does NOT
replace the Hadron-wide constitution; it inherits from it and adds
server-specific refinements + additional invariants. Cross-cutting
principles (test-first, docs-concurrent, accessibility, brainstorm→
spec→implement, zero-trust apps, spec-code coherence) and the 14
technology invariants live in the parent and are not restated here.

Sections added:
- Inheritance pin (parent constitution + version + SHA)
- Refinements (server-local interpretations of inherited principles)
- Server Technology Invariants (additional, server-only)
- Spec Workflow (where server-targeted specs live)
- Governance

Templates requiring updates:
- none yet — no `.specify/templates/` overrides exist in
  hadron-server at ratification time. When server-local templates
  are introduced, this section flags them for sync.

Follow-up TODOs:
- none.
-->

# Hadron Server Constitution

## Inheritance

This constitution **extends** the Hadron-wide constitution at
`spec-kits/.specify/memory/constitution.md`, version **1.3.0**,
SHA `35246dbdf0421ae7831690bf63120041f6569d31` (last amended
2026-05-07).

The parent's six core principles (I–VI) and 14 technology invariants
apply to all work in this repository unmodified. This document only
captures server-specific **refinements** to those principles and
**additional** server-only invariants. In any conflict between the
parent and this document, the **more specific** rule wins (per the
parent's Conflict Resolution clause); if equally specific, the parent
wins.

When the parent is amended, this document MUST be reviewed within the
amending PR and either re-ratified at its current version (if no
server-local impact) or amended in lockstep.

## Refinements

These refine inherited principles for server-local work. Numbering
follows the parent.

### I. Pragmatic Test-First — server scope

The parent requires unit tests for deterministic code, evaluation
tests for LLM code, and integration tests at contract boundaries.
Server-local interpretation:

- **Every GraphQL mutation that touches the graph or access control
  MUST have an integration test** in [`src/test/integration/`](../../src/test/integration/).
  The test exercises the resolver end-to-end against a real Postgres
  (`hadron_test`), not a mocked Prisma client. "Touches access
  control" includes: anything that reads/writes `Memory`,
  `MemoryNode`, `AppMember`, `AgentSubscription`, `AgentOrgGrant`,
  `AppKey`, or any resolver path gated by `requireOrgRole` /
  `requireAppRole` / equivalent.
- **MCP tools that expose graph reads/writes are likewise contract
  boundaries** and require integration tests under
  [`src/test/integration/`](../../src/test/integration/) or
  [`src/test/graphql/`](../../src/test/graphql/) as appropriate.
- Tests run against `hadron_test` (pinned by `vitest.config.ts`
  regardless of `.env`); they never touch `hadron_dev`.

### II. Docs-Concurrent — server scope

`hadron-docs` remains the canonical user-facing documentation site
(per the parent). In addition:

- **GraphQL schema doc-comments are co-canonical with `hadron-docs`
  for the GraphQL surface.** Schema changes that add, remove, or
  rename a type / field / argument MUST update the doc-comment in
  [`src/api/graphql/schema/typeDefs.ts`](../../src/api/graphql/schema/typeDefs.ts)
  in the same PR. The doc-comment is what GraphQL consumers see in
  introspection and IDE tooling — it is part of the contract, not
  just prose.
- **Migration intent SHOULD be recorded in the migration's directory
  README or comment header**, not just in the spec corpus. Future
  readers reading `prisma/migrations/<timestamp>_<name>/migration.sql`
  should be able to see why the migration exists without cross-
  referencing a spec.

### III. Accessible to Non-Technical Readers — server boundary

The parent says error messages MUST state what happened in human
terms AND what the user can do about it. The server is where most
of those messages originate. Server-local rule:

- **Every error that crosses the GraphQL boundary MUST be a typed
  error** with a stable `extensions.code` matching a known error
  class name (e.g., `AgentNotFoundError`, `AppNotFoundError`,
  `InvalidRoleError`, `MaxMembersExceededError`,
  `MemoryNotFoundError`, `OrphanAppError`). The pattern is the one
  established in [`src/lib/entityRef/errors.ts`](../../src/lib/entityRef/errors.ts).
- **Raw Prisma exceptions MUST NOT escape to the wire.** A response
  containing `extensions.code: "INTERNAL_SERVER_ERROR"` plus a raw
  Prisma message (e.g., `Invalid prisma.node.update() invocation:
  An operation failed because it depends on one or more records...`)
  is a violation. Resolvers MUST catch ORM-level exceptions and map
  them to typed errors with friendly messages before returning. The
  classes of "expected" Prisma errors (record-not-found,
  unique-violation, foreign-key-violation) each have a canonical
  typed-error mapping; unexpected exceptions get logged and return
  a generic typed error rather than leaking ORM internals.

### V. Zero-Trust Apps — server is THE enforcement point

The parent says Hadron is the authoritative enforcement point for
access to memory. The server is where that enforcement lives.
Server-local rule:

- **Every resolver and MCP tool that reads or writes graph data
  MUST go through the access-control layer.** Direct Prisma
  queries that bypass `requireOrgRole`, `requireAppRole`, the
  `AppMember` / `AgentSubscription` checks, or the personal-memory
  ownership gate (parent Invariant 13) are violations.
- **Membership-management mutations** (`addSubscriptionMember`,
  `removeSubscriptionMember`, `ensureAppMember`, `removeAppMember`,
  etc.) are *the* mutations where Apps may invoke server APIs to
  manage roles — but the access-control checks themselves
  (per-read / per-write authorization) MUST remain server-side and
  MUST NOT trust App-supplied role/membership claims.
- **Rate limits and abuse controls are server concerns.** No
  resolver should defer rate-limiting to the App.

## Server Technology Invariants

These are **additional** to the parent's 14 invariants and apply
only within `hadron-server`. Changing any of them requires a server
constitution amendment (and may also require a parent amendment if
it affects an inherited invariant).

S1. **Stack pin** — TypeScript on Node.js ≥ 22, Prisma + PostgreSQL,
    Vitest for tests, GraphQL via the existing schema/resolver
    layer in [`src/api/graphql/`](../../src/api/graphql/),
    `strict: true` TypeScript. Replacing the framework, the ORM, or
    the database, or removing strict TypeScript, requires a MAJOR
    amendment to **both** this document and the parent's
    Invariant 9.

S2. **Typed-error boundary** — every error reaching the GraphQL
    response MUST be either (a) a typed error with `extensions.code`
    set to a known class name, or (b) caught and translated to one
    before serialization. Raw Prisma exceptions, raw `TypeError` /
    `ReferenceError`, and bare `new Error("...")` reaching the wire
    are violations. The pattern lives in
    [`src/lib/entityRef/errors.ts`](../../src/lib/entityRef/errors.ts);
    new typed errors join that module (or a sibling module under
    `src/lib/`). Codified after the [hadron-server#100](https://github.com/hadron-memory/hadron-server/issues/100)
    `moveNode` incident leaked a raw Prisma message through GraphQL.

S3. **`typeDefs.ts` is one backtick template literal** —
    [`src/api/graphql/schema/typeDefs.ts`](../../src/api/graphql/schema/typeDefs.ts)
    wraps the entire schema in a single backtick-delimited template
    literal. Doc-comments inside the template literal MUST NOT
    contain raw backticks — backticks would terminate the template
    literal and break the build. Use single quotes, `<<<…>>>`, or
    unicode look-alikes if a code-fenced effect is needed inside a
    doc-comment. Specifically called out by the 009 T017 task
    during the `agentId: ID!` change.

S4. **Composite-PK models in `MODELS_WITHOUT_ID`** — Prisma models
    without an auto-generated `id` column (e.g., `AgentSubscription`,
    `AppMember`, `AgentImport`, `AgentOrgGrant`) MUST be added to
    the `MODELS_WITHOUT_ID` list in
    [`src/integrations/db/client.ts`](../../src/integrations/db/client.ts).
    The Prisma client extension uses that list to skip the
    auto-id-injection pass; missing entries cause silent query
    breakage. New composite-PK models added in a migration MUST
    include the `MODELS_WITHOUT_ID` update in the same PR.

S5. **CHECK constraints live in `prisma/post-push.sql`** — Postgres
    CHECK constraints (e.g., `chk_personal_visibility_user`,
    `chk_memory_class_app_id`) are not expressible in Prisma's
    schema language. They live in
    [`prisma/post-push.sql`](../../prisma/post-push.sql) and MUST
    be re-applied after every `prisma db push` against `hadron_dev`
    or `hadron_test`. Adding a new structural-data invariant
    (a new CHECK or UNIQUE constraint that backstops an
    application-layer rule) MUST add the corresponding SQL to
    `post-push.sql` AND a regression test that verifies the
    constraint is in place. The application code is the
    user-friendly error-message layer; the database is the
    truth-keeper.

S6. **CI grep gates stay in sync with `spec-kits/.specify/memory/`
    templates** — the [`no-station-refs.yml`](../../.github/workflows/no-station-refs.yml)
    (spec 003) and [`no-agent-specific-code.yml`](../../.github/workflows/no-agent-specific-code.yml)
    (parent Invariant 14) workflows under
    [`.github/workflows/`](../../.github/workflows/) are installed
    copies of templates maintained in `spec-kits/.specify/memory/`.
    When the templates change, the installed copies MUST be updated
    within the same release. New constitution-invariant-enforcing
    grep gates that the parent introduces MUST be installed here
    unless an exemption is explicitly justified in this
    constitution.

## Spec Workflow

Per the convention also encoded in `hadron-portal/.specify/memory/constitution.md`:

- **All Hadron specs — including server-only specs — live under**
  `spec-kits/specs/NNN-name/`. The server repo does NOT host its
  own `specs/` directory. Reasons: a single contiguous ID space,
  graceful handling of scope creep when a "server-only" spec
  unexpectedly expands to touch `hadron-portal` or `hadron-client`,
  and co-location with brainstorming summaries in
  `hadron-concept/design-discussions/`.
- A spec whose **Repos & PRs** section lists only `hadron-server`
  is what we mean by "server-targeted." It still goes through
  `/speckit-specify`, `/speckit-clarify`, `/speckit-plan`,
  `/speckit-tasks`, `/speckit-implement`, `/speckit-finalize` from
  the `spec-kits/` root.
- Trade-off accepted: PRs in `hadron-server` cannot bundle
  spec-corpus edits with code edits, because the spec corpus lives
  in a sibling repo. Spec-Code Coherence (parent Principle VI) is
  enforced across both PRs at finalize time.

## Governance

Amendments to this document follow the parent's amendment process,
scoped to server:

1. A dated brainstorming session in
   `hadron-concept/design-discussions/` proposing the change (the
   parent's Principle IV applies).
2. A PR against this file with a populated Sync Impact Report
   (version delta, changed items, templates requiring updates).
3. A version bump under semantic versioning, identical in meaning
   to the parent:
   - **MAJOR** — a refinement or server invariant is removed or
     redefined incompatibly.
   - **MINOR** — a new refinement, server invariant, or mandatory
     section is added.
   - **PATCH** — wording, typo, or non-semantic refinement.

**Parent sync**: when the parent constitution is amended, every PR
that amends the parent MUST either (a) confirm in its description
that no server-local impact exists, or (b) include a paired
amendment to this file. Server contributors reviewing parent-
amendment PRs are responsible for flagging server impact.

**Conflict resolution**: as stated under Inheritance — more specific
rule wins; equally specific, parent wins; unresolved tension MUST
be called out in the affected `plan.md` rather than silently
chosen.

**Version**: 1.0.0 | **Ratified**: 2026-05-06 | **Last Amended**: 2026-05-06
