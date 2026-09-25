-- #1322 / D-2026-09-24-001 — rule keys are lower-case dotted roles.
--
-- Node.role itself deliberately remains an open string. Only the two tables
-- whose values are interpreted as lookup keys carry this invariant.
-- #1345 review (@copilot): name any existing rule key the new CHECKs would
-- refuse, and say what to do, instead of failing on an opaque constraint
-- violation. (The tables arrived in 20260925030000 and have no write path
-- before #1325(b), so none is expected; this makes the unexpected actionable.)
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s:%s (%L)', src, id, role), ', ') INTO bad FROM (
    SELECT 'node_role_rules' AS src, id, role FROM node_role_rules
     WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$')
    UNION ALL
    SELECT 'memory_config_template_rules', id, role FROM memory_config_template_rules
     WHERE NOT (char_length(role) BETWEEN 1 AND 64 AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$')
    LIMIT 20
  ) t;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '#1322: rule keys the dotted grammar refuses (lower-case letter/digit/dash segments joined by dots, 1-64 characters). Rename or delete these rules, then re-run: %', bad;
  END IF;
END $$;

ALTER TABLE node_role_rules
  ADD CONSTRAINT chk_node_role_rule_role_format
  CHECK (
    char_length(role) BETWEEN 1 AND 64
    AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$'
  );

ALTER TABLE memory_config_template_rules
  ADD CONSTRAINT chk_memory_config_template_rule_role_format
  CHECK (
    char_length(role) BETWEEN 1 AND 64
    AND role ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$'
  );
