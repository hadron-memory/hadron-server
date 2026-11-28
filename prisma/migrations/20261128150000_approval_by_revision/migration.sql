-- #5481 — approval by revision (Holger, 2026-11-28; decision record
-- hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles, sections 7
-- and 9). From this server on a revision is approved only when an approval is recorded AT it: its own history row carries
-- one, or it is the live revision under the node's standing approval. The earlier rule of
-- hrn:node:hadronmemory.com:specs:cor:dmo:060:04 ("approved when some recorded approval covers its content, whichever
-- revision it was recorded on") is gone: the text of another revision no longer approves anything.
--
-- Part 1 (schema). `node_revisions.approved_rev_no`: the revision the approval a row carries was recorded at. NULL on a row
-- whose approval was recorded at its own revision (every row before this migration, and the record's own row after it);
-- lower than `rev_no` on a row that carries an approval forward (the revision writer does that for each later revision
-- that left the title, abstract and content unchanged; hrn:node:hadronmemory.com:specs:cor:dmo:120:04).
--
-- Part 2 (one-time re-anchoring, ruled by Holger on 2026-11-28: "It is ok to bless whatever is served today. All is
-- approved by known humans."). Rows written before this migration carry an approval only at the revision it was
-- recorded at, so a revision the OLD rule read approved through another revision's record would stop reading approved
-- at deploy. So that day one serves exactly what was served the day before, the approval the old rule found for such a
-- revision is recorded AT it, with the original approver, approval time and hash, and the revision it was recorded at:
--
--   2a. a history row that carries no approval of its own, whose text hashes to a still-valid approval record of the
--       same node from the same capture memory, recorded at that revision or an earlier one;
--   2b. a live node whose approval does not stand (its content changed since) but whose current text hashes to a
--       still-valid record on one of its history rows: the node's approval is re-anchored at its current revision.
--
-- Scope: only nodes that sit in an Agent's system memory or an install memory (where boot prompts, their sources and
-- the rules they include live), and never an encrypted memory. Nothing is deleted, and no row that already carries any
-- approval column is touched. A valid record is one with a hash that its own row's text still hashes to (the old rule's
-- integrity condition). A revision older than the record that covers its text is NOT re-anchored: no approval is
-- recorded before its revision exists.
--
-- This migration never refuses on data: there is no RAISE EXCEPTION, every statement is a no-op where nothing qualifies, and it
-- can be run again (a re-anchored row carries an approval, so the second run skips it). The counts are reported as a
-- NOTICE. A read-only query that lists what it will change, to run before deploy, is
-- scripts/db/approval-by-revision-predeploy-5481.sql.

ALTER TABLE "node_revisions" ADD COLUMN IF NOT EXISTS "approved_rev_no" INTEGER;

-- Approval hash v1 (src/lib/approvalHash.ts, hrn:node:hadronmemory.com:specs:cor:dmo:120:01), byte for byte: a version
-- line, then title, abstract and content, each `<name> null` or `<name> <UTF-8 byte length>`, a newline, the value and a
-- newline; CRLF and a lone CR become LF first. Session-local, dropped below; its search path is pinned like every
-- function a migration makes (#5096), though it names nothing outside pg_catalog.
CREATE OR REPLACE FUNCTION pg_temp.approval_hash_5481(p_title text, p_abstract text, p_content text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $fn$
  SELECT encode(sha256(convert_to(
    'hadron-approval-v1' || E'\n'
    || (SELECT CASE WHEN v IS NULL THEN 'title null' || E'\n'
                    ELSE 'title ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
          FROM (SELECT replace(replace(p_title, E'\r\n', E'\n'), E'\r', E'\n') AS v) t)
    || (SELECT CASE WHEN v IS NULL THEN 'abstract null' || E'\n'
                    ELSE 'abstract ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
          FROM (SELECT replace(replace(p_abstract, E'\r\n', E'\n'), E'\r', E'\n') AS v) a)
    || (SELECT CASE WHEN v IS NULL THEN 'content null' || E'\n'
                    ELSE 'content ' || octet_length(convert_to(v, 'UTF8')) || E'\n' || v || E'\n' END
          FROM (SELECT replace(replace(p_content, E'\r\n', E'\n'), E'\r', E'\n') AS v) c),
    'UTF8')), 'hex')
$fn$;

-- The nodes in scope, with the hash of their current text and whether their own approval stands (the status rule,
-- #1611, with the integrity condition).
DROP TABLE IF EXISTS approval_5481_nodes;
CREATE TEMP TABLE approval_5481_nodes AS
SELECT n.id AS node_id, n.memory_id, n.rev_seq, n.content_rev_seq,
       h.live_hash,
       (n.approved_rev_no IS NOT NULL AND n.approved_at IS NOT NULL AND n.approval_hash IS NOT NULL
         AND n.content_rev_seq <= n.approved_rev_no AND n.approval_hash = h.live_hash) AS stands,
       n.approved_rev_no, n.approved_by, n.approved_by_info, n.approved_at, n.approval_hash
FROM nodes n
JOIN memories m ON m.id = n.memory_id
CROSS JOIN LATERAL (SELECT pg_temp.approval_hash_5481(n.name, n.abstract, n.content) AS live_hash) h
WHERE NOT m.is_encrypted
  AND (EXISTS (SELECT 1 FROM agents a WHERE a.system_memory_id = m.id) OR (m.class = 'system' AND m.is_install_memory));
CREATE INDEX ON approval_5481_nodes (node_id);

-- Every numbered history row of those nodes, with the hash of its own text and the memory it was captured in (a legacy
-- row with no memory belongs to the node's). `own_valid`: it carries a record its text still hashes to.
DROP TABLE IF EXISTS approval_5481_rows;
CREATE TEMP TABLE approval_5481_rows AS
SELECT r.id AS row_id, r.node_id, r.rev_no, r.memory_id AS row_memory_id, COALESCE(r.memory_id, n.memory_id) AS capture_memory_id,
       n.memory_id AS node_memory_id, h.text_hash,
       (r.approved_at IS NOT NULL AND r.approval_hash IS NOT NULL AND r.approval_hash = h.text_hash) AS own_valid,
       (r.approved_at IS NULL AND r.approval_hash IS NULL AND r.approved_by IS NULL AND r.approved_by_info IS NULL) AS carries_nothing,
       r.approved_by, r.approved_by_info, r.approved_at, r.approval_hash
FROM node_revisions r
JOIN approval_5481_nodes n ON n.node_id = r.node_id
CROSS JOIN LATERAL (SELECT pg_temp.approval_hash_5481(r.name, r.abstract, r.content) AS text_hash) h
WHERE r.rev_no IS NOT NULL;
CREATE INDEX ON approval_5481_rows (node_id, text_hash);

-- The valid approval records the old rule consulted: each row's own, and the node's standing approval. `hash` is the
-- hash the record itself holds (which a valid record's text still hashes to).
DROP TABLE IF EXISTS approval_5481_records;
CREATE TEMP TABLE approval_5481_records AS
SELECT node_id, rev_no AS recorded_at, row_memory_id AS record_memory_id, FALSE AS is_standing, approval_hash AS hash,
       approved_by, approved_by_info, approved_at
FROM approval_5481_rows WHERE own_valid
UNION ALL
SELECT node_id, approved_rev_no, memory_id, TRUE, approval_hash, approved_by, approved_by_info, approved_at
FROM approval_5481_nodes WHERE stands;
CREATE INDEX ON approval_5481_records (node_id, hash);

-- 2a. History rows: the earliest valid record of the same capture memory that covers the row's text, recorded at or
-- before the row's revision. A capture in an encrypted memory is never read (NOT_APPLICABLE).
DROP TABLE IF EXISTS approval_5481_row_blessing;
CREATE TEMP TABLE approval_5481_row_blessing AS
SELECT DISTINCT ON (t.row_id) t.row_id, c.recorded_at, c.approved_by, c.approved_by_info, c.approved_at, c.hash
FROM approval_5481_rows t
JOIN approval_5481_records c
  ON c.node_id = t.node_id AND c.hash = t.text_hash AND c.recorded_at <= t.rev_no
 AND CASE WHEN c.is_standing THEN t.capture_memory_id = t.node_memory_id
          ELSE c.record_memory_id = t.capture_memory_id OR (c.record_memory_id IS NULL AND t.capture_memory_id = t.node_memory_id) END
WHERE NOT t.own_valid AND t.carries_nothing
  AND NOT EXISTS (SELECT 1 FROM memories em WHERE em.id = t.capture_memory_id AND em.is_encrypted)
ORDER BY t.row_id, c.recorded_at ASC, c.is_standing ASC;

-- 2b. Live nodes whose approval does not stand, with no history row at their own revision number (such a row, not the
-- node, is that revision), whose current text a valid row record of this memory covers.
DROP TABLE IF EXISTS approval_5481_node_blessing;
CREATE TEMP TABLE approval_5481_node_blessing AS
SELECT DISTINCT ON (n.node_id) n.node_id, c.approved_by, c.approved_by_info, c.approved_at, c.hash
FROM approval_5481_nodes n
JOIN approval_5481_records c
  ON c.node_id = n.node_id AND c.hash = n.live_hash AND NOT c.is_standing AND c.recorded_at <= n.rev_seq
 AND (c.record_memory_id = n.memory_id OR c.record_memory_id IS NULL)
WHERE NOT n.stands AND n.content_rev_seq <= n.rev_seq
  AND NOT EXISTS (SELECT 1 FROM node_revisions x WHERE x.node_id = n.node_id AND x.rev_no = n.rev_seq)
ORDER BY n.node_id, c.recorded_at ASC;

-- `node_revisions.approved_by` references users; a record's approver who no longer has a row is kept as text.
UPDATE node_revisions r
SET approved_by = CASE WHEN u.id IS NOT NULL THEN b.approved_by END,
    approved_by_info = COALESCE(b.approved_by_info, CASE WHEN u.id IS NULL THEN COALESCE('user:' || b.approved_by, 'unknown') END),
    approved_at = b.approved_at,
    approval_hash = b.hash,
    approved_rev_no = b.recorded_at
FROM approval_5481_row_blessing b
LEFT JOIN users u ON u.id = b.approved_by
WHERE r.id = b.row_id
  AND r.approved_at IS NULL AND r.approval_hash IS NULL AND r.approved_by IS NULL AND r.approved_by_info IS NULL;

-- chk_node_approval_complete wants an approver or an approver note. `updated_at` is not touched: an approval is not an
-- authoring change.
UPDATE nodes n
SET approved_rev_no = n.rev_seq,
    approved_by = b.approved_by,
    approved_by_info = COALESCE(b.approved_by_info, CASE WHEN b.approved_by IS NULL THEN 'unknown' END),
    approved_at = b.approved_at,
    approval_hash = b.hash
FROM approval_5481_node_blessing b
WHERE n.id = b.node_id AND n.rev_seq > 0;

DO $$
DECLARE row_count integer; node_count integer;
BEGIN
  SELECT count(*) INTO row_count FROM approval_5481_row_blessing;
  SELECT count(*) INTO node_count FROM approval_5481_node_blessing;
  RAISE NOTICE 'approval_by_revision_5481: re-anchored % history row(s) and % live node(s)', row_count, node_count;
END $$;

DROP TABLE approval_5481_node_blessing;
DROP TABLE approval_5481_row_blessing;
DROP TABLE approval_5481_records;
DROP TABLE approval_5481_rows;
DROP TABLE approval_5481_nodes;
DROP FUNCTION pg_temp.approval_hash_5481(text, text, text);
