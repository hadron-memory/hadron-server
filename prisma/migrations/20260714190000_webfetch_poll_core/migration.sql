-- Core routing/audit binding for sidecar-owned webfetch poll jobs.
CREATE TABLE "webfetch_poll_bindings" (
    "job_id" TEXT NOT NULL,
    "source_run_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT,
    "entry_node_urn" TEXT NOT NULL,
    "policy" JSONB,
    "credentials_node_urn" TEXT,
    "url" TEXT NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webfetch_poll_bindings_pkey" PRIMARY KEY ("job_id")
);

CREATE INDEX "webfetch_poll_bindings_organization_id_app_id_cancelled_at_idx"
    ON "webfetch_poll_bindings"("organization_id", "app_id", "cancelled_at");
CREATE INDEX "webfetch_poll_bindings_source_run_id_idx"
    ON "webfetch_poll_bindings"("source_run_id");
ALTER TABLE "webfetch_poll_bindings"
    ADD CONSTRAINT "webfetch_poll_bindings_source_run_id_fkey"
    FOREIGN KEY ("source_run_id") REFERENCES "app_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Completed dispatch receipts for at-least-once sidecar events.
CREATE TABLE "webfetch_event_receipts" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "snapshot_hash" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "routed_run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webfetch_event_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webfetch_event_receipts_job_id_snapshot_hash_kind_key"
    ON "webfetch_event_receipts"("job_id", "snapshot_hash", "kind");
CREATE INDEX "webfetch_event_receipts_created_at_idx"
    ON "webfetch_event_receipts"("created_at");
CREATE INDEX "webfetch_event_receipts_routed_run_id_idx"
    ON "webfetch_event_receipts"("routed_run_id");
ALTER TABLE "webfetch_event_receipts"
    ADD CONSTRAINT "webfetch_event_receipts_routed_run_id_fkey"
    FOREIGN KEY ("routed_run_id") REFERENCES "app_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
