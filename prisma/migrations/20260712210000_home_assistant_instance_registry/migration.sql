-- Registered Home Assistant instances — the org-scoped registry behind
-- the hadrontool-home-assistant capability tool (hadron-server#640).
-- Mirrors mcp_servers: hard delete by design (config, not audit
-- history), so the (org, slug) unique is plain, not partial.
CREATE TABLE "home_assistant_instances" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "op_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "home_assistant_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "home_assistant_instances_org_slug_uniq" ON "home_assistant_instances"("organization_id", "slug");

ALTER TABLE "home_assistant_instances" ADD CONSTRAINT "home_assistant_instances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
