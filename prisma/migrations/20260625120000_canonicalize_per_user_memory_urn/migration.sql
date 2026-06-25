-- #352: per-user runtime memory URNs were stored with the non-canonical `user`
-- role marker (`<org>:<agent>:user:<opaqueId>`). `user` is a reserved spec-021
-- *type* word, so `Memory.urn` canonicalization on read (#318) threw
-- `reserved-word-slug` and fell back to serving the raw single-colon value.
-- Align storage to the canonical `app-user` per-user role marker (spec-021 D4)
-- so the read layer's existing role-marker handling serves a clean,
-- round-trippable URN with no per-read special-casing.
--
-- Scope is deliberately narrow:
--   * Only the per-user marker segment is rewritten. `user` cannot appear
--     anywhere else in a memory URN — it is a reserved word and slug atoms are
--     colon-delimited — and the anchored pattern matches `:user:<leaf>` only at
--     the END of the URN (the opaqueId is a single colon-free atom).
--   * `~ ':user:[^:]+$'` already excludes canonical `::`-form rows; the
--     `NOT LIKE '%::%'` guard is belt-and-suspenders.
--   * Idempotent: rows already on `:app-user:` do not match.
--
-- Anonymous (`:anon:`) rows are intentionally NOT touched — `anon` is now a
-- first-class spec-021 role marker (this same change adds it to the marker
-- registry), so the stored word is already canonical; only the read layer
-- needed to learn to preserve its `marker:id` boundary.
--
-- Assets are unaffected: `assets.storage_key` is persisted once at upload and
-- read directly on download — it is never recomputed from `Memory.urn`, so
-- existing objects keep resolving under their original `.../user/...` keys.
UPDATE "memories"
SET "urn" = regexp_replace("urn", ':user:([^:]+)$', ':app-user:\1')
WHERE "urn" ~ ':user:[^:]+$'
  AND "urn" NOT LIKE '%::%';
