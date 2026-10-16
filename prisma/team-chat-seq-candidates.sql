-- #992 canonical classifier: mirrors locateTeamChatRoot's team-space shape,
-- but retains all historical roots/messages (including soft-deleted owners).
-- No envelope test: encrypted envelopes and unstamped imports are eligible.
SELECT n.id AS node_id, r.id AS root_id, n.memory_id, n.loc, n.seq,
       n.deleted_at, m.urn AS memory_urn
FROM nodes n
JOIN nodes r ON r.memory_id = n.memory_id AND r.loc = 'chats:team' AND r.node_type = 'chat'
JOIN memories m ON m.id = n.memory_id
JOIN apps a ON a.id = m.app_id
WHERE m.class = 'app' AND m.user_memory_of_agent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.memory_id = m.id)
  AND (m.owner_user_id IS NULL OR m.owner_user_id = a.owner_user_id)
  AND starts_with(n.loc, r.loc || ':messages:')
  AND n.node_type = 'chat-message' AND n.seq IS NOT NULL
