-- Registered external MCP servers — the org-scoped registry behind the
-- hadrontool-mcp conduit. Hard delete by design (config, not audit
-- history), so the (org, slug) unique is plain, not partial.
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headers_encrypted" TEXT,
    "tool_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_servers_org_slug_uniq" ON "mcp_servers"("organization_id", "slug");

ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
