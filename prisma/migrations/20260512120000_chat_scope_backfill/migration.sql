-- Spec 017 (chat-visibility-and-personal-memory) — FR-017/FR-018.
--
-- Classifies every pre-feature chat-root node as `data.scope = 'private'`.
-- All pre-feature chats live in personal-class memory (today's behavior
-- before this feature shipped); reclassifying them as private preserves
-- their existing visibility semantics — they remain visible only to
-- their author.
--
-- Chat-root nodes are addressed by:
--   loc LIKE 'chats:%'  AND  loc NOT LIKE '%:messages%'
--
-- The chat subtree under a chat-root is `chats:<id>:messages` (container)
-- and `chats:<id>:messages:<seq>-*` (message rows); both contain
-- ':messages', and chat-root locs do not. Aligning the predicate with
-- the `myChats` resolver's filter (`NOT { loc: { contains: ':messages' } }`)
-- keeps the two definitions of "chat-root" in lockstep.
--
-- The migration is **idempotent**: a second run touches no rows because
-- the WHERE filter excludes nodes that already have `data.scope`. No
-- chat content moves between memories (FR-018) — only the JSON `scope`
-- field on the chat-root node is set.

UPDATE "nodes"
SET "data" = jsonb_set(
  COALESCE("data", '{}'::jsonb),
  '{scope}',
  '"private"',
  true
)
WHERE "loc" LIKE 'chats:%'
  AND "loc" NOT LIKE '%:messages%'
  AND ("data" IS NULL OR "data" ->> 'scope' IS NULL);
