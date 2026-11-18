-- #3818 V25: new binds record their immediate successor; historical ends remain NULL.
ALTER TABLE "sessions" ADD COLUMN "superseded_by_session_id" TEXT;
