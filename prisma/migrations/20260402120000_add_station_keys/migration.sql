-- CreateTable
CREATE TABLE "station_keys" (
    "id" TEXT NOT NULL,
    "station_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "label" TEXT,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "station_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "station_keys_station_id_idx" ON "station_keys"("station_id");

-- AddForeignKey
ALTER TABLE "station_keys" ADD CONSTRAINT "station_keys_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "station_keys" ADD CONSTRAINT "station_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing station keys into station_keys table
INSERT INTO station_keys (id, station_id, user_id, key_hash, label, created_at, created_by)
SELECT
  gen_random_uuid()::text,
  s.id,
  COALESCE(s.user_id, s.created_by, ''),
  s.key_hash,
  'Initial key',
  s.created_at,
  s.created_by
FROM stations s
WHERE s.key_hash IS NOT NULL AND s.deleted_at IS NULL;
