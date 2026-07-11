-- 046-usage-metering (billing Phase 0): billing attribution + cost snapshot
-- on usage_events, the ModelPrice rate table, and the append-only
-- credit_ledger_entries monetary ledger. Additive only. See
-- specs/046-usage-metering/spec.md and prisma/schema.prisma.

-- AlterTable: usage_events gains attribution + cost columns
ALTER TABLE "usage_events" ADD COLUMN "user_id" TEXT;
ALTER TABLE "usage_events" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "usage_events" ADD COLUMN "provider" TEXT;
ALTER TABLE "usage_events" ADD COLUMN "key_owner_type" TEXT;
ALTER TABLE "usage_events" ADD COLUMN "cost_micro_cents" BIGINT;

-- CreateIndex
CREATE INDEX "usage_events_user_id_idx" ON "usage_events"("user_id");

-- CreateIndex
CREATE INDEX "usage_events_organization_id_created_at_idx" ON "usage_events"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "model_prices" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "input_micro_cents_per_mtok" BIGINT NOT NULL,
    "output_micro_cents_per_mtok" BIGINT NOT NULL,
    "markup_basis_points" INTEGER,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_prices_provider_model_tier_effective_at_key" ON "model_prices"("provider", "model", "tier", "effective_at");

-- CreateIndex
CREATE INDEX "model_prices_provider_model_tier_idx" ON "model_prices"("provider", "model", "tier");

-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_micro_cents" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "source_type" TEXT,
    "source_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_ledger_entries_organization_id_created_at_idx" ON "credit_ledger_entries"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
