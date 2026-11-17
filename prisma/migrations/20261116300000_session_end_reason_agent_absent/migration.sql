-- #4292 (S15 of #4229): the host ends an open SHORT_LIVED session after proving no agent runs, and records the end as
-- `agent_absent` (cor:agt:050:10, Proposed amendment). Expand-safe: one added value, written only by this image; the
-- previous image never writes it. Standalone ADD VALUE, referenced by nothing in this transaction; IF NOT EXISTS keeps
-- `migrate deploy` idempotent, as this repo's other enum additions.
ALTER TYPE "SessionEndReason" ADD VALUE IF NOT EXISTS 'agent_absent';
