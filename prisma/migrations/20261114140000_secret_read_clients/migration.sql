-- #3998 (S3 of #3991) — secret read clients. Expand only: one new table. The invariants block below is byte-identical
-- to prisma/secret-read-clients-invariants.sql (pinned by a test).

-- CreateTable
CREATE TABLE "secret_read_clients" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "secret_id" TEXT NOT NULL,
    "secret_name" TEXT NOT NULL,
    "issuer_user_id" TEXT,
    "self_issued" BOOLEAN NOT NULL,
    "end_reason" TEXT,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'::text),

    CONSTRAINT "secret_read_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "secret_read_clients_grant_id_key" ON "secret_read_clients"("grant_id");

-- CreateIndex
CREATE INDEX "secret_read_clients_app_id_secret_id_idx" ON "secret_read_clients"("app_id", "secret_id");

-- CreateIndex
CREATE INDEX "secret_read_clients_issuer_user_id_idx" ON "secret_read_clients"("issuer_user_id");

-- AddForeignKey
ALTER TABLE "secret_read_clients" ADD CONSTRAINT "secret_read_clients_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "grants"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "secret_read_clients" ADD CONSTRAINT "secret_read_clients_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- #3998 (S3 of #3991) — secret read clients: the association of one grant with one App secret. Prisma cannot model these.
-- One source, shared verbatim with migration 20261114140000_secret_read_clients; applied after grant-invariants.sql.

ALTER TABLE secret_read_clients DROP CONSTRAINT IF EXISTS chk_secret_read_client_end;
ALTER TABLE secret_read_clients ADD CONSTRAINT chk_secret_read_client_end CHECK (
  (end_reason IS NULL AND ended_at IS NULL)
  OR (end_reason IN ('SECRET_DELETED', 'PROTECTED') AND ended_at IS NOT NULL));

-- Immutable but for its one end: the grant, App, secret, issuer and self-issued mark never change, and an end is set
-- once from NULL (a client holds no window, budget or counter, so there is nothing else to alter).
CREATE OR REPLACE FUNCTION hadron_secret_read_client_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.app_id IS DISTINCT FROM OLD.app_id OR NEW.secret_id IS DISTINCT FROM OLD.secret_id
     OR NEW.secret_name IS DISTINCT FROM OLD.secret_name OR NEW.issuer_user_id IS DISTINCT FROM OLD.issuer_user_id
     OR NEW.self_issued IS DISTINCT FROM OLD.self_issued OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A secret read client is immutable once issued' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'A secret read client ends once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_read_client_guard ON secret_read_clients;
CREATE TRIGGER secret_read_client_guard BEFORE UPDATE ON secret_read_clients
FOR EACH ROW EXECUTE FUNCTION hadron_secret_read_client_guard();

-- A client's secret is an App secret of the client's own App (secret_id carries no foreign key, so a trigger).
CREATE OR REPLACE FUNCTION hadron_secret_read_client_secret() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM secrets WHERE id = NEW.secret_id AND owner_type = 'app' AND owner_id = NEW.app_id) THEN
    RAISE EXCEPTION 'A secret read client names an App secret of its own App' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS secret_read_client_secret ON secret_read_clients;
CREATE TRIGGER secret_read_client_secret BEFORE INSERT ON secret_read_clients
FOR EACH ROW EXECUTE FUNCTION hadron_secret_read_client_secret();

-- A secret's deletion ends every client of it (R2); the id is never reused, so the end is permanent.
CREATE OR REPLACE FUNCTION hadron_secret_deleted_ends_clients() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE secret_read_clients SET end_reason = 'SECRET_DELETED', ended_at = (clock_timestamp() AT TIME ZONE 'UTC')
   WHERE secret_id = OLD.id AND ended_at IS NULL;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS secret_deleted_ends_clients ON secrets;
CREATE TRIGGER secret_deleted_ends_clients BEFORE DELETE ON secrets
FOR EACH ROW EXECUTE FUNCTION hadron_secret_deleted_ends_clients();
