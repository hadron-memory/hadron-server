-- Spec 049 Phase 3 (D-2026-09-13-002) — the session's ACTIVE SCOPE on the MCP
-- surface (`hadron_set_active_scope`), persisted per client instance beside
-- the App, memory and organization selections (#1012, spec 049 Phase 1).
--
-- Rung 2 of the search ladder: a scope named in the call › THIS › the active
-- App (`app`) › the active organization (`global`) › refusal. Nullable and
-- ON DELETE SET NULL like its siblings — a cache of a choice, never a grant;
-- re-authorized through the scope read gate on every restore.

ALTER TABLE "mcp_session_state"
    ADD COLUMN IF NOT EXISTS "scope_id" TEXT;

CREATE INDEX IF NOT EXISTS "mcp_session_state_scope_id_idx"
    ON "mcp_session_state" ("scope_id");

ALTER TABLE "mcp_session_state"
    ADD CONSTRAINT "mcp_session_state_scope_id_fkey"
    FOREIGN KEY ("scope_id") REFERENCES "scopes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
