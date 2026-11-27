-- #5027 (hrn:node:hadronmemory.com:specs:cor:acl:030:01, D-2026-11-26-008): the Agent's default chat home.
-- Nullable, no backfill: null keeps today's behaviour for every existing Agent.
CREATE TYPE "ChatHome" AS ENUM ('APP_SHARED', 'PERSONAL', 'PRIVATE');

ALTER TABLE "agents" ADD COLUMN "default_chat_home" "ChatHome";
