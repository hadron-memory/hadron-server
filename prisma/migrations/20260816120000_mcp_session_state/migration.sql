-- #1012 — McpSessionState: a client's DURABLE MCP selections (active App, active memory).
--
-- The in-process selection maps in src/mcp/server.ts live for exactly one MCP
-- TRANSPORT session, and clients re-initialize transparently after a server
-- restart — so a selection silently evaporated mid-conversation (#1005). #1009
-- made that loss legible, and recoverable for callers holding a Hadron session
-- id; this table is the remedy for everyone else, including plain memory work
-- with no session at all.
--
-- Keyed on (user_id, client_key), NOT on the MCP session id — which is exactly
-- the thing that does not survive a reconnect. `client_key` is the caller's own
-- stable instance id, supplied per request via the `X-Hadron-Client-Id` header.
-- A client that sends none is never persisted and keeps the pre-#1012 in-memory
-- behaviour, so this table only ever holds rows for clients that opted in.
--
-- Per-CLIENT rather than per-USER on purpose (Holger, 2026-08-16): one person
-- may drive Claude Desktop, Cursor and the CLI at once, and a per-user row would
-- let one switch the others' active App mid-conversation — turning a LOST
-- selection into a SILENTLY WRONG one, which is worse than the bug being fixed.
--
-- Both pointers are nullable and ON DELETE SET NULL: this is a CACHE OF A
-- CHOICE, never a grant. A deleted App or memory must degrade the row to
-- "nothing selected" rather than dangle or cascade the whole row away (the
-- sibling selection is still good). Authorization is NOT implied by storage —
-- the runtime re-authorizes both pointers on every read (`isAppParticipant` for
-- the App, the memory read gate for the memory), because a stored selection
-- outlives the membership that justified it (#475, and the #1007 review finding
-- where a bespoke member-row check drifted from the shared gate).
--
-- user_id cascades: a deleted user's client selections are meaningless.

CREATE TABLE IF NOT EXISTS "mcp_session_state" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_key" TEXT NOT NULL,
    "app_id" TEXT,
    "memory_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "mcp_session_state_pkey" PRIMARY KEY ("id")
);

-- The upsert target: one row per (user, client instance).
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_session_state_user_client_uniq"
    ON "mcp_session_state" ("user_id", "client_key");

-- Supporting indexes for the SET NULL paths.
CREATE INDEX IF NOT EXISTS "mcp_session_state_app_id_idx" ON "mcp_session_state" ("app_id");
CREATE INDEX IF NOT EXISTS "mcp_session_state_memory_id_idx" ON "mcp_session_state" ("memory_id");

ALTER TABLE "mcp_session_state"
    ADD CONSTRAINT "mcp_session_state_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_session_state"
    ADD CONSTRAINT "mcp_session_state_app_id_fkey"
    FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mcp_session_state"
    ADD CONSTRAINT "mcp_session_state_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
