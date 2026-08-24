-- #1079 — the URN alias map.
--
-- Four entities store their URN in a column (organizations, memories, agents,
-- apps) and all four can be renamed. Nothing recorded the old URN, so a rename
-- silently 404'd every published reference — and because most URNs are COMPOSED
-- on read from one of these (a node URN carries its memory's slug, a worker URN
-- its App's slug), renaming one memory orphaned every published node URN under
-- it. This table is the record that heals them: the derived URNs resolve
-- THROUGH their parent's ref resolver, so aliasing the four storing entities is
-- sufficient.
--
-- The alias urn is deliberately NOT unique: an old URN becomes free on rename
-- and may be taken by a new entity, and two entities may legitimately have held
-- the same urn at different times. Resolvers try the live `urn` column first and
-- fail loudly on an ambiguous alias rather than guessing.

CREATE TYPE "UrnAliasEntityType" AS ENUM ('ORGANIZATION', 'MEMORY', 'AGENT', 'APP');
CREATE TYPE "UrnAliasReason" AS ENUM ('RENAME', 'ORG_RENAME_CASCADE', 'V1_MIGRATION');

CREATE TABLE "urn_aliases" (
    "id" TEXT NOT NULL,
    "urn" TEXT NOT NULL,
    "entity_type" "UrnAliasEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason" "UrnAliasReason" NOT NULL,
    "replaced_by_urn" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "urn_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "urn_aliases_urn_entity_uniq" ON "urn_aliases"("urn", "entity_type", "entity_id");
CREATE INDEX "urn_aliases_urn_entity_type_idx" ON "urn_aliases"("urn", "entity_type");
CREATE INDEX "urn_aliases_entity_type_entity_id_idx" ON "urn_aliases"("entity_type", "entity_id");

-- Backfill the #697 v1→v2 aliases this table supersedes, so resolution has ONE
-- place to look rather than two that can disagree. The `legacy_urn` columns and
-- their per-resolver fallbacks stay in place for now and are read ALONGSIDE this
-- table (deduplicated by entity id), so a row this backfill somehow missed still
-- resolves; retiring the columns is a follow-up, not a prerequisite.
--
-- `legacy_urn` is already stored in the normalized lookup form (the #697
-- migration wrote it that way and the existing fallbacks query it directly), so
-- it is carried over verbatim rather than re-normalized here — re-deriving it in
-- SQL would risk disagreeing with the TypeScript normalizer that has to match it.
--
-- ON CONFLICT DO NOTHING makes the backfill idempotent: this migration is the
-- only writer of V1_MIGRATION rows, but a re-run (or a partially-applied
-- migration recovered by hand) must not fail on the unique index.
INSERT INTO "urn_aliases" ("id", "urn", "entity_type", "entity_id", "reason", "replaced_by_urn")
SELECT gen_random_uuid()::text, m."legacy_urn", 'MEMORY', m."id", 'V1_MIGRATION', m."urn"
FROM "memories" m
WHERE m."legacy_urn" IS NOT NULL AND m."legacy_urn" <> ''
ON CONFLICT DO NOTHING;

INSERT INTO "urn_aliases" ("id", "urn", "entity_type", "entity_id", "reason", "replaced_by_urn")
SELECT gen_random_uuid()::text, a."legacy_urn", 'AGENT', a."id", 'V1_MIGRATION', a."urn"
FROM "agents" a
WHERE a."legacy_urn" IS NOT NULL AND a."legacy_urn" <> ''
ON CONFLICT DO NOTHING;

INSERT INTO "urn_aliases" ("id", "urn", "entity_type", "entity_id", "reason", "replaced_by_urn")
SELECT gen_random_uuid()::text, ap."legacy_urn", 'APP', ap."id", 'V1_MIGRATION', ap."urn"
FROM "apps" ap
WHERE ap."legacy_urn" IS NOT NULL AND ap."legacy_urn" <> ''
ON CONFLICT DO NOTHING;
