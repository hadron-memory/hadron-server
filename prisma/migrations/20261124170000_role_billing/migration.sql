-- #5012 (Billing A5): the BILLING platform role, which may write credit grants and adjustments and nothing else.
-- Expand-safe: one added value, written only by this image; the previous image never writes it (and its auth
-- middleware drops a role it does not know, so a user holding it fails closed there). Standalone ADD VALUE,
-- referenced by nothing in this transaction; IF NOT EXISTS keeps `migrate deploy` idempotent, as this repo's other
-- enum additions.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'BILLING';
