-- #2168: customisation is not installation membership. No node/memory FK:
-- a deleted prompt target must remain a typed refusal instead of falling through.
CREATE TABLE app_agent_customizations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE ON UPDATE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE ON UPDATE CASCADE,
  boot_prompt_node_id TEXT,
  boot_prompt_urn TEXT,
  PRIMARY KEY (app_id, agent_id)
);
CREATE INDEX app_agent_customizations_boot_prompt_node_id_idx ON app_agent_customizations(boot_prompt_node_id);

-- #2168: customisation state is not an installation row and outlives its target.
ALTER TABLE app_agent_customizations DROP CONSTRAINT IF EXISTS chk_app_agent_customizations_boot_prompt_pointer_pair;
ALTER TABLE app_agent_customizations ADD CONSTRAINT chk_app_agent_customizations_boot_prompt_pointer_pair
  CHECK ((boot_prompt_node_id IS NULL) = (boot_prompt_urn IS NULL));
