-- Spec 049 Phase 1 (D-2026-09-13-003) — the EXPLICITLY selected active
-- organization on the MCP surface, persisted per client instance beside the
-- active App and active memory (#1012).
--
-- The portal has forced an active organization since spec 014; the CLI and
-- MCP had no way to set one, and `Session` carries an App but no org. This
-- column is the `hadron_set_active_org` selection. It is the THIRD rung of the
-- resolution ladder in src/lib/auth/activeOrg.ts — a named org in the call and
-- an org-owned active App both outrank it — so a row whose `app_id` names an
-- org-owned App reads its org from the App, not from here.
--
-- Nullable and ON DELETE SET NULL for the same reason as the sibling pointers:
-- a cache of a choice, never a grant. Re-authorized against current org
-- membership on every read (`getMemberOrgIds`); a membership revoked since the
-- selection drops the selection rather than honouring it.

ALTER TABLE "mcp_session_state"
    ADD COLUMN IF NOT EXISTS "organization_id" TEXT;

CREATE INDEX IF NOT EXISTS "mcp_session_state_organization_id_idx"
    ON "mcp_session_state" ("organization_id");

ALTER TABLE "mcp_session_state"
    ADD CONSTRAINT "mcp_session_state_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
