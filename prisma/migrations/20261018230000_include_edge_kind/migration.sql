-- #2040: derived include edges. The enum value commits here, in its own
-- migration, before 20261018230100 uses it in functions and triggers.
ALTER TYPE "EdgeGovernedKind" ADD VALUE IF NOT EXISTS 'INCLUDE';
