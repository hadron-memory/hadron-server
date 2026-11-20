-- #4400 (hrn:node:hadronmemory.com:specs:cor:urn:010:01): a root name is unique regardless of case.
-- `principals.name` has a plain, case-sensitive unique index, and until now only the writers' lower-casing kept
-- `Example` from being stored beside `example`. This CHECK makes the database refuse a name that is not lower
-- case, in every status (active, released, reserved), so the plain unique index IS uniqueness across case.
--
-- Expand-safe: the previous image only ever writes lower-case names, so the CHECK refuses nothing it does.
--
-- Refusal on data (SQLSTATE HDPRF, the refused-migration rule): if a mixed-case row exists, adding the CHECK
-- would fail, and lower-casing it here could merge two owners' roots. Which owner keeps a root is a person's
-- decision, so the migration refuses and changes nothing. Read-only production preflight: the two queries on
-- hadron-server#4400.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM principals WHERE name <> lower(name);
  IF n > 0 THEN
    RAISE EXCEPTION 'principals.name: % row(s) are not lower case; repair them before chk_principals_name_lower can be added (hadron-server#4400)', n
      USING ERRCODE = 'HDPRF';
  END IF;
END $$;

ALTER TABLE "principals" DROP CONSTRAINT IF EXISTS "chk_principals_name_lower";
ALTER TABLE "principals" ADD CONSTRAINT "chk_principals_name_lower" CHECK (name = lower(name));
