-- Spec: 005-agent-subscription — Part 1 of 2.
--
-- Adds the new 'PERSONAL' value to the existing MemoryVisibility enum.
-- Must be its own migration: PostgreSQL forbids using a newly-added enum
-- value within the same transaction that adds it ("unsafe use of new
-- value of enum type"), and Prisma's migration engine wraps every
-- migration file in an implicit transaction. The enum value is therefore
-- committed here in isolation; the rest of the 005 changes are applied
-- in 20260430030001_agent_subscription_main.
--
-- See specs/005-agent-subscription/contracts/migration-sql.md for the
-- full sequencing rationale.

ALTER TYPE "MemoryVisibility" ADD VALUE IF NOT EXISTS 'PERSONAL';
