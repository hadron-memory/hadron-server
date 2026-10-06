-- Ruling DY-3: a per-App switch for startAgentSession's hard expiry. Default
-- true keeps every existing App's behavior; false means no hard expiry unless
-- the call asks for one.
ALTER TABLE "apps" ADD COLUMN "agent_sessions_expire" BOOLEAN NOT NULL DEFAULT true;
