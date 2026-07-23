-- URN-shape guardrail (spec 047 follow-up).
--
-- `memories.urn` stores the BARE grammar-v2 form `<root>:<slug>` (single colon,
-- NO scheme prefix); the display layer (`emitEntityUrnV2`) prepends `hrn:mem:`.
-- Storing the already-rendered display string via a raw UPDATE double-prefixes
-- it (`hrn:mem:hrn:mem:<root>:<slug>`), which fails `parseUrn` and is then
-- SILENTLY dropped from the portal's memory listing. This CHECK rejects that
-- class of write at the source, including hand-edits that bypass the app layer.
--
-- NOT VALID: enforced on every INSERT/UPDATE, but existing rows are not
-- re-checked, so adding it can never fail on a DB that holds a legacy oddity.
-- A later `VALIDATE CONSTRAINT`, after a data audit, can promote it.
ALTER TABLE "memories" DROP CONSTRAINT IF EXISTS "chk_memory_urn_not_prefixed";
ALTER TABLE "memories" ADD CONSTRAINT "chk_memory_urn_not_prefixed" CHECK ("urn" NOT LIKE 'hrn:%') NOT VALID;
