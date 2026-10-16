import { readFileSync } from 'node:fs';

/** #992: the SAME literal classifier embedded in the migration, before any DDL. */
export const teamChatSeqCandidatesSql = readFileSync(new URL('../../prisma/team-chat-seq-candidates.sql', import.meta.url), 'utf8');

/** Read-only census: returns every colliding identity/address, never message plaintext. */
export const teamChatSeqPreflightSql = `WITH eligible AS (${teamChatSeqCandidatesSql})
SELECT root_id, memory_id, memory_urn, seq,
       jsonb_agg(jsonb_build_object('id', node_id, 'loc', loc, 'deletedAt', deleted_at) ORDER BY loc) AS messages
FROM eligible GROUP BY root_id, memory_id, memory_urn, seq HAVING count(*) > 1
ORDER BY memory_id, root_id, seq`;

/** Census size makes a zero-collision report distinguishable from an empty set. */
export const teamChatSeqSummarySql = `WITH eligible AS (${teamChatSeqCandidatesSql})
SELECT count(*)::text AS "canonicalMessages", count(DISTINCT root_id)::text AS "canonicalRoots",
       count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS "tombstonedMessages"
FROM eligible`;
