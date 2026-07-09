-- hadron-server#396: the ms-exchange capability tool (hadrontool-ms-exchange)
-- now owns provider state (refresh tokens, Graph subscriptions). Core keeps
-- the connection identity plus the tool's connection id for routing.
--
-- refresh_token_encrypted goes nullable (new rows never carry a token) but is
-- NOT dropped yet — it is the rollback path until the one-time core→tool
-- token transfer (src/admin/transfer-exchange-tokens.ts) is verified. A
-- follow-up migration drops it.

ALTER TABLE "exchange_connections" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'ms-exchange';
ALTER TABLE "exchange_connections" ADD COLUMN "tool_connection_id" TEXT;
ALTER TABLE "exchange_connections" ALTER COLUMN "refresh_token_encrypted" DROP NOT NULL;
