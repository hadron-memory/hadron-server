-- #2068 — a ticker may tick whether or not there is unread chat (cor:agt:080:10). Off for every existing ticker.
ALTER TABLE "tickers" ADD COLUMN "wake_without_chat" BOOLEAN NOT NULL DEFAULT false;
