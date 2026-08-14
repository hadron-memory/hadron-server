-- #974 (PR #978 review — Copilot) — a worker's MENTION TOKEN is unique per App.
--
-- `workers_app_name_uniq` (20260814130000) makes the display NAME unique per
-- App case-insensitively, which is the spec rule (cor:agt:020:02) — but the
-- mention contract (cor:agt:020:04) does not address a worker by its name, it
-- addresses it by the slug of its name: `mentionTokenOf` in
-- resolvers.teamChat.ts lowercases and collapses out-of-atom runs to `-`. That
-- map is many-to-one, so "Mary Jane" and "Mary-Jane" are two legal castings in
-- one App that share the single address `@mary-jane`: neither could be
-- mentioned unambiguously, and filtering by either worker's id returned the
-- other's messages too.
--
-- The token is therefore unique as well. The expression MIRRORS mentionTokenOf
-- step for step (lower → collapse out-of-atom runs → trim non-alphanumeric
-- ends); both are IMMUTABLE, so the functional index is legal. Names whose
-- token is empty ("!!!") are unaddressable rather than colliding, so they are
-- excluded from the index instead of all sharing the '' slot.
--
-- Prisma cannot express a functional/partial unique, so this lives here, in
-- prisma/post-push.sql, and in src/test/globalSetup.ts — all three must stay in
-- sync, and any change to mentionTokenOf must change all of them.

CREATE UNIQUE INDEX "workers_app_mention_token_uniq"
  ON "workers" (
    "app_id",
    regexp_replace(
      regexp_replace(
        regexp_replace(lower("name"), '[^a-z0-9._-]+', '-', 'g'),
        '^[^a-z0-9]+', ''),
      '[^a-z0-9]+$', '')
  )
  WHERE regexp_replace(
          regexp_replace(
            regexp_replace(lower("name"), '[^a-z0-9._-]+', '-', 'g'),
            '^[^a-z0-9]+', ''),
          '[^a-z0-9]+$', '') <> '';
