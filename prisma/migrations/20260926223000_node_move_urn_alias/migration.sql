-- #1391: a node move changes its composed URN without renaming its memory.
-- Node aliases use the existing URN alias map and its (urn, type, id) unique.
ALTER TYPE "UrnAliasEntityType" ADD VALUE IF NOT EXISTS 'NODE';
