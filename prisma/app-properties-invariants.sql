-- #3125 S1 (cor:dmo:050:20): an App's properties are one JSON object when set, and the revision counter never goes
-- below zero. The byte and depth caps are judged by the server before any write, as a task's properties are.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS chk_apps_properties;
ALTER TABLE apps ADD CONSTRAINT chk_apps_properties CHECK (
  (properties IS NULL OR jsonb_typeof(properties) = 'object') AND properties_revision >= 0
);
