-- #2948: Google connect hub — the account hint rides the DB-backed start nonce from
-- POST /auth/{gmail,google-cal,google-drive}/start to the authorize redirect, where it becomes
-- Google's login_hint. Nullable: every non-Google start and every hint-less start writes NULL.
ALTER TABLE "auth_handoff_codes" ADD COLUMN "login_hint" TEXT;
