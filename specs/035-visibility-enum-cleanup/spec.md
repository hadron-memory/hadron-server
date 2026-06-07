# Spec 035 — Visibility enum cleanup

Status: in progress · Owner: Holger · Branch: `feat/spec-035-visibility-enum-cleanup`
Follows: spec 034 (memory-class access) · Handoff:
`urn:node:hadronmemory.com::dev::handoffs:2026-06-07-visibility-enum-cleanup`
(decision D-2026-06-05-002).

## Why

`MemoryVisibility` is overloaded. It is the type of **both** `Memory.visibility`
and `Agent.visibility`, and it still carries `PERSONAL`/`PRIVATE` values that
spec 034 made dead weight for memories — privacy is now expressed by the
`personal`/`private` **class**, not by visibility. The vestigial `Memory.type`
(`MemoryType { KNOWLEDGE, AGENT_SYSTEM }`) is the other half of the same debt.

This spec finishes the cleanup: split agents onto their own enum, make memory
visibility nullable + meaningful only for `knowledge`/`group`, drop the dead
enum values, and remove `Memory.type`.

## Decisions

1. **`Agent.visibility` gets its own `AgentVisibility { PUBLIC, ORGANIZATION,
   PERSONAL }`** (default `PERSONAL`). It is decoupled from `MemoryVisibility`.
   - The creator-only "draft" state (today `PRIVATE`) becomes **`PERSONAL`** —
     *not* `PRIVATE` — so the agent value never collides with the memory
     `private` **class** semantics. (Holger, 2026-06-07.)
   - Migration maps existing agent visibility `PUBLIC`/`ORGANIZATION` 1:1 and
     everything else (`PRIVATE`/`PERSONAL`/`GROUP`) → `PERSONAL`.

2. **`Memory.visibility` becomes nullable, no default.** It is meaningful only
   for `knowledge` (`PUBLIC`/`ORGANIZATION`) and `group` (`GROUP`); for
   `system`/`app`/`personal`/`private` it is `NULL`.

3. **`MemoryVisibility` → `{ PUBLIC, ORGANIZATION, GROUP }`** (drop
   `PERSONAL`, `PRIVATE`). `createMemory` knowledge default → `ORGANIZATION`
   (was `PRIVATE`); personal/private/system/app set `NULL`.

4. **Remove `Memory.type` + `MemoryType`.** Read/write sites branch on
   `class` (`type='AGENT_SYSTEM'` ⇒ `class='system'`).

## New invariant

`chk_memory_visibility_class` — `CHECK (visibility IS NULL OR class IN
('knowledge','group'))`. Forbids a non-null visibility on any other class.
(Loose form, per 034 tasks.md T006: it forbids non-null elsewhere but does not
*require* non-null on knowledge/group — application code defaults knowledge to
`ORGANIZATION`.) Synced across **4 sites**: the migration,
`prisma/post-push.sql`, `src/test/globalSetup.ts`, and the schema doc-comment.

## type↔class reconciliation (non-obvious)

`type` and `class` **diverge today**: seed system memories are `class='system'`
with `type='KNOWLEDGE'` (default), while the create-chatbot wizard sets
`type='AGENT_SYSTEM'` on a memory whose `class` stays `'knowledge'`. So removing
`type` is **not** a clean rename:

- The migration backfills `class='system' WHERE type='AGENT_SYSTEM' AND
  class<>'system'` **before** dropping the column.
- The wizard write sites (`createAgent`/`updateAgent` system-memory attach) now
  set `class='system'` (and stop setting `visibility` on the system memory —
  the new CHECK forbids it).

## Access-control implications (review-critical)

Today the GraphQL `getAccessibleMemoryIds` (resolvers.ts) owner-gates two things
via `visibility='PRIVATE'`:
- per-user **knowledge "holding" memories** (`userMemoryOfAgentId` set), created
  by the `startChat` no-App downgrade; and
- the `createMemory` `PRIVATE` default for plain knowledge memories.

Dropping `PRIVATE` means:
- Plain knowledge memories become `ORGANIZATION` (org-visible) — **intended**
  (handoff). Migration remaps `knowledge PRIVATE → ORGANIZATION`.
- Per-user holding memories must **stay owner-only**. Gating moves off
  `visibility` onto `userMemoryOfAgentId` (mirrors the
  `chathistory-knowledge-class-auth-gap` finding): the org clause excludes
  `userMemoryOfAgentId IS NOT NULL`, and an explicit owner clause
  (`userMemoryOfAgentId NOT NULL AND createdBy = caller`) re-admits the caller's
  own.
- The org clause is rewritten to `class IN ('knowledge','group')`, which
  preserves the prior set (app/system were excluded by the old `PRIVATE`
  default and stay excluded — they are reached via AppMember / the agent
  surface, not the visibility-driven node query).

The **MCP** path (`src/mcp/access-control.ts`) never used visibility — it is
class + AppMember + `userMemoryOfAgentId` based — so it is unaffected.

## Out of scope

- Renaming `chk_personal_visibility_user` / `chk_memory_personal_agent_id`
  (the 034 naming-debt rename) — left as-is.
- Reworking the `startChat` no-App `knowledge` downgrade to a now-legal
  free-standing `personal` memory (spec 034 relaxed the constraint that forced
  it). Tracked as a follow-up; keeps this PR's blast radius contained.

## Validate

`pnpm tsc --noEmit`; `prisma db push` to `hadron_test` + `psql -f
post-push.sql`; full `pnpm test`. Watch chat/session + agent-visibility tests.
