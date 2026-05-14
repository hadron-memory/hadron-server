-- Spec 017 (chat-visibility-and-personal-memory) — FR-017/FR-018.
--
-- Classifies every pre-feature chat-root node as `data.scope = 'private'`.
-- Pre-feature chats live in either personal-class memory (the post-005
-- per-user path) OR knowledge-class memory (the legacy fallback at
-- `startChat`'s "agent's first writable attached memory" branch).
-- Reclassifying both as `private` preserves their existing visibility
-- semantics — they remain visible only to their author. No chat
-- content moves between memories (FR-018); only the JSON `scope`
-- field on the chat-root node is set. The runtime validator in
-- `chat-scope.ts:validateChatScopeInvariants` accepts the
-- `private + knowledge` combination as a permanent legacy state.
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
-- the WHERE filter excludes nodes that already have `data.scope`.

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
