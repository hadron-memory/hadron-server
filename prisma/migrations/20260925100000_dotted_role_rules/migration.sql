-- #1322 / D-2026-09-24-001 — rule keys are lower-case dotted roles.
--
-- Node.role itself deliberately remains an open string. Only the two tables
-- whose values are interpreted as lookup keys carry this invariant.
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
