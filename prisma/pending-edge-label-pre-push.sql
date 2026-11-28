-- #4588: the migrationless counterpart of the pending_edges rename in 20260620120000_edge_first_class.
-- Without it, db push over a legacy table drops `label` and adds an empty `name`, losing the edge names.
-- Only a table with `label` and no `name` is touched. Prisma's push then adds the nullable
-- loc, description and data columns. Independent of the edges transition: either table can lag.
DO $pending_edge_label$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pending_edges' AND column_name = 'label'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pending_edges' AND column_name = 'name'
  ) THEN
    ALTER TABLE "pending_edges" RENAME COLUMN "label" TO "name";
  END IF;
END
$pending_edge_label$;
