-- #1602: nullable first for NULL-only independent backfill, no database defaults.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS trailer TEXT;
UPDATE workers SET signature = '— [{{worker.name}}, {{worker.role}}]({{worker.url}}) · {{session.llmModel}}' WHERE signature IS NULL;
UPDATE workers SET trailer = 'Worker: {{worker.name}} ({{worker.role}}) <{{worker.url}}>' WHERE trailer IS NULL;
ALTER TABLE workers ALTER COLUMN signature SET NOT NULL;
ALTER TABLE workers ALTER COLUMN trailer SET NOT NULL;
