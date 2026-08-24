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
-- NARROW BY CONSTRUCTION. Only a row whose stored name is EXACTLY what the old
-- composer would have produced is touched:
--
--   * it is an app-class, non-deleted memory;
--   * its App and its identity Agent are named IDENTICALLY (the only case the
--     old code stuttered — a genuinely two-named pairing like
--     "Eng Team WL — Second Agent — shared chats" is correct and must survive);
--   * and its name literally equals `<app> — <agent> — <anything>`.
--
-- A hand-edited name matches none of those and is left alone. That matters more
-- than covering every row: a cosmetic repair that overwrites a name someone
-- chose is a worse outcome than a label that reads oddly.
--
-- Kind-agnostic on purpose: the trailing segment is carried over verbatim rather
-- than assumed to be 'shared chats', so a future app-class memory kind inherits
-- the repair instead of being silently skipped.
--
-- Idempotent: after this runs the names no longer match the predicate, so a
-- re-run (or a hand-recovered migration) updates zero rows.
--
-- The separator is U+2014 EM DASH surrounded by spaces, matching
-- `sharedMemoryName` exactly. A different dash would match nothing and this
-- migration would silently do nothing, which is why it is spelled out here.
--
-- `starts_with`, NOT `LIKE` (PR #1083 review, Codex P2). These are free-form
-- display names, so an App called "Eng_Team" or "50% Team" puts a LIKE WILDCARD
-- into the pattern: `_` matches any character and `%` matches any run of them.
-- A hand-renamed memory whose prefix merely resembles `<app> — <agent>` would
-- then match, and the SET below would slice it at an offset computed from the
-- LITERAL prefix length — corrupting exactly the hand-chosen name this migration
-- promises to leave alone. `starts_with` is a literal comparison with no
-- metacharacters, and is what the URN cascades already use for the same reason.

UPDATE "memories" m
SET "name" = ap."name" || substring(m."name" FROM length(ap."name" || ' — ' || a."name") + 1)
FROM "apps" ap, "agents" a
WHERE m."class" = 'app'
  AND m."deleted_at" IS NULL
  AND m."app_id" = ap."id"
  AND m."shared_memory_of_agent_id" = a."id"
  AND ap."name" = a."name"
  AND starts_with(m."name", ap."name" || ' — ' || a."name" || ' — ');
