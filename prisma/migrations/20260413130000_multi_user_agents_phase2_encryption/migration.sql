-- Multi-user agents: Phase 2 (Tier 2.5 encryption)
-- Adds Memory.isEncrypted flag. The actual encryption is applied at write
-- time by the application using data keys provided via startAgentSession;
-- there is no schema-level encryption primitive. This migration is purely
-- additive — existing rows default to false (plaintext), and Tier 2 continues
-- to work exactly as before.

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "is_encrypted" BOOLEAN NOT NULL DEFAULT false;
