-- #2831 S1 (cor:agt:060:12): model groups, declared by an Agent and overridable by an App. Additive only.

-- CreateTable
CREATE TABLE "model_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent_id" TEXT,
    "app_id" TEXT,
    "patterns" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "model_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_groups_agent_id_name_key" ON "model_groups"("agent_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "model_groups_app_id_name_key" ON "model_groups"("app_id", "name");

-- AddForeignKey
ALTER TABLE "model_groups" ADD CONSTRAINT "model_groups_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_groups" ADD CONSTRAINT "model_groups_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A group belongs to exactly one owner. Synced with prisma/post-push.sql.
ALTER TABLE "model_groups"
  ADD CONSTRAINT "chk_model_group_owner" CHECK (num_nonnulls("agent_id", "app_id") = 1);
