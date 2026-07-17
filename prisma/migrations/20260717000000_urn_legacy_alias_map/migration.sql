-- #697 stored legacy->canonical alias map.
--
-- The URN grammar v2 online migration (#697) will flip `urn` from its v1 form to
-- the flat v2 form, but the mapping cannot be a string rewrite: migration
-- *assigns* the new slug and auto-suffixes an author-derived alias on collision
-- (the local-alias-mint rule, #695), so an old chain URN can't be reconstructed
-- from the new one. Resolution therefore needs a STORED map — each row records
-- the pre-v2 URN it was migrated FROM, and a legacy input (wikilink, export,
-- external link) redirects to the row by matching `legacy_urn`.
--
-- Added to the three URN-bearing entities (memories, agents, apps). Node/Edge
-- URNs are computed from the memory URN, so they self-heal — no column needed.
--
-- Non-unique + indexed: a live row's legacy URN is unique in practice, but the
-- column also lives on soft-deleted / uninstalled rows, so uniqueness is not
-- enforced at the DB level; resolution disambiguates a rare collision to the
-- live row (else a typed ambiguity error, per #697). NULL until the row is
-- migrated. Transient — dropped with the spec-021/#697 URN cleanup, alongside
-- `urn_normalized_at` / `urn_migration_failed_reason`.
ALTER TABLE "memories" ADD COLUMN "legacy_urn" TEXT;
ALTER TABLE "agents"   ADD COLUMN "legacy_urn" TEXT;
ALTER TABLE "apps"     ADD COLUMN "legacy_urn" TEXT;

CREATE INDEX "memories_legacy_urn_idx" ON "memories" ("legacy_urn");
CREATE INDEX "agents_legacy_urn_idx"   ON "agents" ("legacy_urn");
CREATE INDEX "apps_legacy_urn_idx"     ON "apps" ("legacy_urn");
