-- #1156 / cor:dmo:070:05: no default or backfill. Older ends remain unknown.
CREATE TYPE "SessionEndReason" AS ENUM ('ended', 'superseded', 'expired');
ALTER TABLE "sessions" ADD COLUMN "end_reason" "SessionEndReason";
