-- 023-app-shape — Migration 1 of 2: enum additions ONLY.
--
-- Postgres rejects same-transaction usage of `ALTER TYPE … ADD VALUE`,
-- so the new MemoryClass.group and MemoryVisibility.GROUP values must
-- commit in their own migration before the next migration references
-- them in CHECK constraints or default values. See
-- spec-kits/specs/023-app-shape/research.md §R-1.

ALTER TYPE "MemoryClass" ADD VALUE 'group';

ALTER TYPE "MemoryVisibility" ADD VALUE 'GROUP';
