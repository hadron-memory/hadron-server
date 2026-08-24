-- #1032 — repair app-class shared-memory names that stutter the App name.
--
-- The COMPOSITION was fixed in #995 (`sharedMemoryName`, PR #999, 2026-08-15):
-- when an App and its Agent are named identically — the normal case for a team,
-- since the getting-started sequence installs "MM Eng Team" as "MM Eng Team" —
-- the label collapses to one instead of "MM Eng Team — MM Eng Team — shared
-- chats". But the name is STORED at provisioning time and nothing recomputes it,
-- so every row created before that fix still carries the doubled form. #1032 was
-- filed two days after the fix landed, against a build that already had it,
-- which is exactly what a stored-vs-computed value looks like from outside.
--
-- Safe to repair, and the reason is worth stating because the issue reasonably
-- doubted it: `Memory.name` is DISPLAY ONLY. Nothing resolves a memory by name —
-- refs resolve by id or `urn`, and the urn is untouched here. The caution about
-- renaming a memory being disruptive is true of its URN (see #1079) and not of
-- its label. The portal renders this one in the team-chat breadcrumb, so the
-- doubled form is visible rather than buried.
--
-- ## Matched EXACTLY, and why that beats the clever version
--
-- The predicate is a literal equality against the precise string the old
-- composer produced: `<name> — <name> — shared chats`, where the App and its
-- identity Agent are named identically (the only case that stuttered).
--
-- Two earlier drafts were narrower in intent and wider in effect, and both were
-- caught in review (PR #1083, Codex + Copilot independently):
--
--   1. `LIKE <app> || ' — ' || <agent> || ' — %'` — these are FREE-FORM display
--      names, so an App called "Eng_Team" or "50% Team" puts a LIKE WILDCARD in
--      the pattern (`_` matches any character, `%` any run). A hand-renamed
--      memory whose prefix merely RESEMBLED the stutter would match.
--   2. `starts_with(..., '<app> — <agent> — ')` — literal, but still matched any
--      trailing text, so a user-chosen `Team — Team — quarterly notes` was
--      rewritten to `Team — quarterly notes`.
--
-- Draft 2 was written to be "kind-agnostic", so a future app-class memory kind
-- would inherit the repair. That traded a REAL safety property for a
-- HYPOTHETICAL one: `sharedMemoryName` has exactly one non-test caller and it
-- always passes the default kind, so no alternate kind exists to repair — while
-- `updateMemory(name:)` lets a user set any name at all. The speculative
-- generality could only ever have hit hand-chosen labels.
--
-- An exact equality also removes the offset arithmetic entirely: there is no
-- prefix length to compute and therefore no way to slice a name at the wrong
-- place. If a future kind ever ships and needs repairing, it gets its own
-- migration, written when the string it must match is known rather than guessed.
--
-- ## Tombstones are INCLUDED, deliberately
--
-- No `deleted_at IS NULL` filter (PR #1083 review, Codex + Copilot). The
-- canonical `(App, Agent)` lookup in `findOrCreateAppClassMemory` spans
-- soft-deleted rows on purpose, and its `revive` path clears only `deleted_at` /
-- `deleted_by` — it does NOT recompute the name. So a tombstoned stuttered row
-- skipped here would come back with the doubled label on the pairing's next
-- touch, AFTER this one-off migration had already run, and nothing would repair
-- it a second time. Repairing a tombstone is free (the name is display-only and
-- the row is invisible until revived) and it is what makes "one-off" true.
--
-- Idempotent: after this runs the names no longer equal the predicate, so a
-- re-run updates zero rows.
--
-- The separator is U+2014 EM DASH surrounded by spaces, matching
-- `sharedMemoryName` exactly. A different dash would match nothing and this
-- migration would silently do nothing, which is why it is spelled out here.

UPDATE "memories" m
SET "name" = ap."name" || ' — shared chats'
FROM "apps" ap, "agents" a
WHERE m."class" = 'app'
  AND m."app_id" = ap."id"
  AND m."shared_memory_of_agent_id" = a."id"
  AND ap."name" = a."name"
  AND m."name" = ap."name" || ' — ' || a."name" || ' — shared chats';
