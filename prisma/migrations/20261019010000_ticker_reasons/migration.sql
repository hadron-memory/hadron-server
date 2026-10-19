-- #2068 (cor:agt:080:01, :10, Holger R49) — why a ticker fires: a closed list of named reasons. Every existing ticker
-- keeps today's behavior ('read-team-channel'); the unconditional reason is 'every-tick'. No reasons = never fires.
ALTER TABLE "tickers" ADD COLUMN "reasons" TEXT[] NOT NULL DEFAULT ARRAY['read-team-channel']::TEXT[];
