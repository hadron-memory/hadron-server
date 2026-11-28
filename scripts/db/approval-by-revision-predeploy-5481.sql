-- #5481 — read-only pre-deploy census for "approval by revision". Run it BEFORE the server that carries
-- prisma/migrations/20261128150000_approval_by_revision is deployed, under a register grant for the production read:
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/db/approval-by-revision-predeploy-5481.sql
--
-- It writes nothing: the whole file is one READ ONLY transaction, rolled back at the end, with no temporary object.
-- It needs no column that the migration adds, so it runs against today's schema. After the deploy it can be run again
-- as a check (re-anchored rows then carry their own approval, so they no longer appear).
--
-- What it lists, one row per finding, in every memory that is not encrypted:
--
--   served-revision     a node whose newest approved revision is DIFFERENT under the new rule (a revision is approved
--                       only when an approval is recorded at it) from today's (a revision is approved when any recorded
--                       approval covers its text), or empty. `today_rev` is what a serve or an `approved` include picks
--                       today; `new_rule_rev` what it would pick with no re-anchoring; `text_differs` whether the two
--                       hold different text (false: only the revision number moves).
--   signed-revision     a revision that carries a signature and reads approved today but not under the new rule: where
--                       signing is on, a serve that today picks it would have nothing both approved and signed.
--   pinned-include      an include of the newest compile of a compiled boot prompt that PINS a revision (`rev=N`) older
--                       than its target's newest approved revision, or one that reads approved today and would not.
--   pinned-tag          a boot-prompt node whose text holds a pinned include tag (`{{> … rev=N …}}`), shown as written:
--                       the target is not resolved here, so read it with the compile's own lint.
--
-- `re_anchored` says whether the migration's one-time step records the approval AT that revision, so the answer
-- after the deploy is today's: true only in an Agent's system memory or an install memory, for a revision that
-- carries no approval column of its own and whose covering record was recorded at that revision or an earlier one.
-- A finding with `re_anchored = false` is one whose answer CHANGES at deploy.
--
-- No row at all means the rule change alters no answer on this database.

BEGIN TRANSACTION READ ONLY;

WITH candidate AS (
  -- Only a node with some approval evidence can read approved under either rule.
  SELECT id AS node_id FROM nodes WHERE approval_hash IS NOT NULL
  UNION
  SELECT node_id FROM node_revisions WHERE approval_hash IS NOT NULL
),
node_state AS (
  SELECT n.id AS node_id, n.memory_id, n.loc, n.role, n.rev_seq, n.content_rev_seq,
         n.approved_rev_no, n.approved_at, n.approval_hash, m.urn AS memory_urn,
         (EXISTS (SELECT 1 FROM agents a WHERE a.system_memory_id = m.id) OR (m.class = 'system' AND m.is_install_memory)) AS in_scope,
         h.hash AS live_hash,
         (n.approved_rev_no IS NOT NULL AND n.approved_at IS NOT NULL AND n.approval_hash IS NOT NULL
           AND n.content_rev_seq <= n.approved_rev_no AND n.approval_hash = h.hash) AS stands
  FROM nodes n
  JOIN candidate c ON c.node_id = n.id
  JOIN memories m ON m.id = n.memory_id
  -- Approval hash v1 (src/lib/approvalHash.ts), as in the migration.
  CROSS JOIN LATERAL (
    SELECT encode(sha256(convert_to(
      'hadron-approval-v1' || E'\n'
      || (SELECT CASE WHEN v IS NULL THEN 'title null' || E'\n' ELSE 'title ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(n.name, E'\r\n', E'\n'), E'\r', E'\n') AS v) t)
      || (SELECT CASE WHEN v IS NULL THEN 'abstract null' || E'\n' ELSE 'abstract ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(n.abstract, E'\r\n', E'\n'), E'\r', E'\n') AS v) a)
      || (SELECT CASE WHEN v IS NULL THEN 'content null' || E'\n' ELSE 'content ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(n.content, E'\r\n', E'\n'), E'\r', E'\n') AS v) c),
      'UTF8')), 'hex') AS hash
  ) h
  WHERE NOT m.is_encrypted
),
row_state AS (
  SELECT r.id AS row_id, r.node_id, r.rev_no, r.memory_id AS row_memory_id, COALESCE(r.memory_id, n.memory_id) AS capture_memory_id,
         n.memory_id AS node_memory_id, h.hash AS text_hash,
         (r.approved_at IS NOT NULL AND r.approval_hash IS NOT NULL AND r.approval_hash = h.hash) AS own_valid,
         (r.approved_at IS NULL AND r.approval_hash IS NULL AND r.approved_by IS NULL AND r.approved_by_info IS NULL) AS carries_nothing,
         EXISTS (SELECT 1 FROM memories em WHERE em.id = COALESCE(r.memory_id, n.memory_id) AND em.is_encrypted) AS capture_encrypted
  FROM node_revisions r
  JOIN node_state n ON n.node_id = r.node_id
  CROSS JOIN LATERAL (
    SELECT encode(sha256(convert_to(
      'hadron-approval-v1' || E'\n'
      || (SELECT CASE WHEN v IS NULL THEN 'title null' || E'\n' ELSE 'title ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(r.name, E'\r\n', E'\n'), E'\r', E'\n') AS v) t)
      || (SELECT CASE WHEN v IS NULL THEN 'abstract null' || E'\n' ELSE 'abstract ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(r.abstract, E'\r\n', E'\n'), E'\r', E'\n') AS v) a)
      || (SELECT CASE WHEN v IS NULL THEN 'content null' || E'\n' ELSE 'content ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
            FROM (SELECT replace(replace(r.content, E'\r\n', E'\n'), E'\r', E'\n') AS v) c),
      'UTF8')), 'hex') AS hash
  ) h
  WHERE r.rev_no IS NOT NULL
),
record AS (
  -- The valid approval records today's rule consults: each row's own, and the node's standing approval.
  SELECT node_id, rev_no AS recorded_at, row_memory_id AS record_memory_id, FALSE AS is_standing, text_hash AS hash
  FROM row_state WHERE own_valid
  UNION ALL
  SELECT node_id, approved_rev_no, memory_id, TRUE, approval_hash FROM node_state WHERE stands
),
row_cover AS (
  -- Per history row: does any valid record of its capture memory cover its text (today's rule), and is one of them
  -- recorded at or before the row's own revision (what the migration can re-anchor it from)?
  SELECT t.row_id, bool_or(c.recorded_at <= t.rev_no) AS from_at_or_before
  FROM row_state t
  JOIN record c ON c.node_id = t.node_id AND c.hash = t.text_hash
   AND CASE WHEN c.is_standing THEN t.capture_memory_id = t.node_memory_id
            ELSE c.record_memory_id = t.capture_memory_id OR (c.record_memory_id IS NULL AND t.capture_memory_id = t.node_memory_id) END
  GROUP BY t.row_id
),
live_cover AS (
  -- Per node: does a valid ROW record of its own memory cover its current text?
  SELECT DISTINCT n.node_id
  FROM node_state n
  JOIN record c ON c.node_id = n.node_id AND c.hash = n.live_hash AND NOT c.is_standing
   AND (c.record_memory_id = n.memory_id OR c.record_memory_id IS NULL)
),
unit AS (
  -- Every revision of a candidate node: its numbered history rows, and the live revision when no row holds its number.
  SELECT t.node_id, t.rev_no AS rev, t.text_hash,
         (t.row_memory_id IS NULL OR t.row_memory_id = t.node_memory_id) AS servable,
         (NOT t.capture_encrypted AND t.own_valid) AS new_ok,
         (NOT t.capture_encrypted AND rc.row_id IS NOT NULL) AS today_ok,
         (n.in_scope AND NOT t.capture_encrypted AND NOT t.own_valid AND t.carries_nothing AND COALESCE(rc.from_at_or_before, FALSE)) AS re_anchored
  FROM row_state t
  JOIN node_state n ON n.node_id = t.node_id
  LEFT JOIN row_cover rc ON rc.row_id = t.row_id
  UNION ALL
  SELECT n.node_id, n.rev_seq, n.live_hash, TRUE,
         n.stands,
         (n.stands OR lc.node_id IS NOT NULL),
         (n.in_scope AND NOT n.stands AND n.content_rev_seq <= n.rev_seq AND lc.node_id IS NOT NULL)
  FROM node_state n
  LEFT JOIN live_cover lc ON lc.node_id = n.node_id
  WHERE NOT EXISTS (SELECT 1 FROM node_revisions x WHERE x.node_id = n.node_id AND x.rev_no = n.rev_seq)
),
newest AS (
  SELECT u.node_id,
         max(u.rev) FILTER (WHERE u.today_ok) AS today_rev,
         max(u.rev) FILTER (WHERE u.new_ok) AS new_rule_rev,
         max(u.rev) FILTER (WHERE u.new_ok OR u.re_anchored) AS after_migration_rev
  FROM unit u
  WHERE u.servable
  GROUP BY u.node_id
),
pin AS (
  -- The pinned includes of each compiled prompt's NEWEST compile, from its recorded provenance.
  SELECT DISTINCT cpr.compiled_node_id, (o.value ->> 'nodeId') AS target_node_id, (o.value -> 'selection' ->> 'rev')::int AS pinned_rev,
         COALESCE((o.value -> 'selection' ->> 'approved')::boolean, FALSE) AS wants_approved
  FROM compiled_prompt_revisions cpr
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(cpr.provenance -> 'occurrences') = 'array' THEN cpr.provenance -> 'occurrences' ELSE '[]'::jsonb END) AS o(value)
  WHERE cpr.compiled_rev_no = (SELECT max(x.compiled_rev_no) FROM compiled_prompt_revisions x WHERE x.compiled_node_id = cpr.compiled_node_id)
    AND jsonb_typeof(o.value -> 'selection' -> 'rev') = 'number'
)
SELECT finding, memory_urn, loc, node_id, role, in_migration_scope, today_rev, new_rule_rev, text_differs, re_anchored, detail
FROM (
  SELECT 'served-revision' AS finding, n.memory_urn, n.loc, n.node_id, n.role, n.in_scope AS in_migration_scope,
         w.today_rev, w.new_rule_rev,
         (w.new_rule_rev IS NULL OR ut.text_hash IS DISTINCT FROM un.text_hash) AS text_differs,
         (w.after_migration_rev IS NOT DISTINCT FROM w.today_rev) AS re_anchored,
         CASE WHEN w.new_rule_rev IS NULL THEN 'nothing reads approved under the new rule' ELSE 'the newest approved revision moves' END AS detail
  FROM newest w
  JOIN node_state n ON n.node_id = w.node_id
  LEFT JOIN LATERAL (SELECT u.text_hash FROM unit u WHERE u.node_id = w.node_id AND u.rev = w.today_rev AND u.servable LIMIT 1) ut ON TRUE
  LEFT JOIN LATERAL (SELECT u.text_hash FROM unit u WHERE u.node_id = w.node_id AND u.rev = w.new_rule_rev AND u.servable LIMIT 1) un ON TRUE
  WHERE w.today_rev IS DISTINCT FROM w.new_rule_rev

  UNION ALL
  SELECT 'signed-revision', n.memory_urn, n.loc, n.node_id, n.role, n.in_scope, u.rev, NULL::int, NULL::boolean, u.re_anchored,
         'signature on revision ' || u.rev || ' (' || (SELECT count(*) FROM node_signatures s WHERE s.node_id = n.node_id AND s.revision = u.rev) || ' signature row(s))'
  FROM unit u JOIN node_state n ON n.node_id = u.node_id
  WHERE u.today_ok AND NOT u.new_ok
    AND EXISTS (SELECT 1 FROM node_signatures s WHERE s.node_id = u.node_id AND s.revision = u.rev)

  UNION ALL
  SELECT 'pinned-include', sm.urn, sn.loc, sn.id, sn.role,
         (EXISTS (SELECT 1 FROM agents a WHERE a.system_memory_id = sm.id) OR (sm.class = 'system' AND sm.is_install_memory)),
         w.today_rev, w.new_rule_rev, NULL::boolean, pu.re_anchored,
         'pins revision ' || p.pinned_rev || ' of ' || COALESCE(tn.memory_urn || ' ' || tn.loc, 'node ' || p.target_node_id)
           || CASE WHEN p.wants_approved THEN ' (approved)' ELSE '' END
           || '; that revision reads approved today: ' || COALESCE(pu.today_ok::text, 'not kept')
           || ', under the new rule: ' || COALESCE(pu.new_ok::text, 'not kept')
  FROM pin p
  JOIN nodes sn ON sn.id = p.compiled_node_id
  JOIN memories sm ON sm.id = sn.memory_id
  LEFT JOIN node_state tn ON tn.node_id = p.target_node_id
  LEFT JOIN newest w ON w.node_id = p.target_node_id
  LEFT JOIN unit pu ON pu.node_id = p.target_node_id AND pu.rev = p.pinned_rev AND pu.servable
  WHERE (w.today_rev IS NOT NULL AND p.pinned_rev < w.today_rev)
     OR (p.wants_approved AND COALESCE(pu.today_ok, FALSE) AND NOT COALESCE(pu.new_ok, FALSE))

  UNION ALL
  SELECT 'pinned-tag', m.urn, n.loc, n.id, n.role,
         (EXISTS (SELECT 1 FROM agents a WHERE a.system_memory_id = m.id) OR (m.class = 'system' AND m.is_install_memory)),
         NULL::int, NULL::int, NULL::boolean, NULL::boolean,
         (SELECT string_agg(tag[1], ' ') FROM regexp_matches(n.content, '(\{\{>[^}]*\mrev=[0-9]+[^}]*\}\})', 'g') AS tag)
  FROM nodes n JOIN memories m ON m.id = n.memory_id
  WHERE NOT m.is_encrypted AND n.deleted_at IS NULL
    AND (n.role = 'boot-prompt' OR n.role LIKE 'boot-prompt.%' OR n.role = 'boot-prompt-rule')
    AND n.content ~ '\{\{>[^}]*\mrev=[0-9]+[^}]*\}\}'
) findings
ORDER BY finding, memory_urn, loc;

ROLLBACK;
