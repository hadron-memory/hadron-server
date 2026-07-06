-- Issue #505 — session-fixation binding for the email magic-link flow.
-- Stores the SHA-256 of the browser nonce set when the link was requested, so
-- the login handoff code minted at verify time is bound to that browser.
-- Nullable for forward-compat; POST /auth/email requires it in practice.

-- AlterTable
ALTER TABLE "email_verification_tokens" ADD COLUMN "client_state_hash" TEXT;
