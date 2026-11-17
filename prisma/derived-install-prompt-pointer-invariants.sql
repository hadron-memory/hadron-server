-- #2168: customisation state is not an installation row and outlives its target.
ALTER TABLE app_agent_customizations DROP CONSTRAINT IF EXISTS chk_app_agent_customizations_boot_prompt_pointer_pair;
ALTER TABLE app_agent_customizations ADD CONSTRAINT chk_app_agent_customizations_boot_prompt_pointer_pair
  CHECK ((boot_prompt_node_id IS NULL) = (boot_prompt_urn IS NULL));
