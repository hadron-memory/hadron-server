-- #3999 R22: capture at passkey issuance, not at request. Legacy and pending rows have no captured fact.
-- LIMIT OF THE TRIGGER BELOW (the migration copy in
-- prisma/migrations/20261120180000_secret_change_requests/migration.sql carries the same function and this limit):
-- a first NULL->value stamp of issued_to_own_worker is judged against the worker's CURRENT hold
-- (held_by_user_id = the grant's issuer at the moment of the write), not against the hold at any earlier moment.
-- The application writes the marker in grant activation (ensureSecretReadClient, src/lib/signing/grantCeremony.ts),
-- so the trigger certifies the signer-held fact but does NOT by itself prove the stamp happened at activation: any
-- later write while the same hold stands would pass the same check. Sealed once captured, never updated.
ALTER TABLE secret_read_clients ADD COLUMN IF NOT EXISTS issued_to_own_worker boolean;
CREATE OR REPLACE FUNCTION hadron_secret_client_own_worker_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected boolean;
BEGIN
 IF TG_OP='UPDATE' AND OLD.issued_to_own_worker IS NOT NULL AND NEW.issued_to_own_worker IS DISTINCT FROM OLD.issued_to_own_worker THEN
  RAISE EXCEPTION 'A read client own-worker issue marker is immutable' USING ERRCODE = '23514';
 END IF;
 IF NEW.issued_to_own_worker IS NOT NULL AND (TG_OP='INSERT' OR OLD.issued_to_own_worker IS NULL) THEN
  SELECT (g.worker_id IS NOT NULL AND COALESCE(w.held_by_user_id=g.issuer_user_id,false)) INTO expected
  FROM grants g LEFT JOIN workers w ON w.id=g.worker_id WHERE g.id=NEW.grant_id AND g.activated_at IS NOT NULL;
  IF expected IS NULL OR NEW.issued_to_own_worker IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'A read client own-worker marker names the actual issuer' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_client_own_worker_immutable ON secret_read_clients;
CREATE TRIGGER secret_client_own_worker_immutable BEFORE INSERT OR UPDATE ON secret_read_clients
 FOR EACH ROW EXECUTE FUNCTION hadron_secret_client_own_worker_immutable();
