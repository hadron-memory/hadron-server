-- #2245: Agent cloning. Provenance column + the append-only clone audit.
ALTER TABLE "agents" ADD COLUMN "cloned_from_agent_ref" TEXT;

CREATE TABLE "agent_clone_audits" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "source_agent_id" TEXT NOT NULL,
    "new_agent_id" TEXT NOT NULL,
    "target_org_id" TEXT,
    "target_user_id" TEXT,
    "node_count" INTEGER NOT NULL,
    "edge_count" INTEGER NOT NULL,
    "skipped_edge_count" INTEGER NOT NULL,
    "import_count" INTEGER NOT NULL,
    "link_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_clone_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_clone_audits_source_agent_id_idx" ON "agent_clone_audits"("source_agent_id");

-- #2245 (R170.6): the Agent-clone audit is append-only and names exactly one target
-- (Prisma can model neither; the migration carries the same statements).
ALTER TABLE agent_clone_audits DROP CONSTRAINT IF EXISTS chk_agent_clone_audit_one_target;
ALTER TABLE agent_clone_audits ADD CONSTRAINT chk_agent_clone_audit_one_target
  CHECK ((target_org_id IS NOT NULL) <> (target_user_id IS NOT NULL));
CREATE OR REPLACE FUNCTION hadron_agent_clone_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_clone_audits is append-only';
END $$;
DROP TRIGGER IF EXISTS agent_clone_audits_immutable ON agent_clone_audits;
CREATE TRIGGER agent_clone_audits_immutable
  BEFORE UPDATE OR DELETE ON agent_clone_audits
  FOR EACH ROW EXECUTE FUNCTION hadron_agent_clone_audit_immutable();
