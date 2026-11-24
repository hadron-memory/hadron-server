-- #5012 (Billing A5): the BILLING platform role, which may write credit grants and adjustments and nothing else.
-- Expand-safe for the deploy: one added value, written only by this image (the previous image never writes it, and
-- the added label alone is harmless to it). NOT safe to roll back past once a row holds it: the previous image's
-- Prisma client throws `Value 'BILLING' not found in enum 'Role'` on any query that reads such a row, so clear the
-- value first (hrn:node:hadronmemory.com:hadron-server:findings:older-prisma-client-throws-on-unknown-enum-value).
-- Standalone ADD VALUE, referenced by nothing in this transaction; IF NOT EXISTS keeps `migrate deploy` idempotent,
-- as this repo's other enum additions.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'BILLING';
