-- #806 — DashboardWidgetPreset: named, user-scoped widget configurations the
-- portal copies into a placement's config on apply (no live link). Owner-only,
-- like dashboard_widgets: no org column, no sharing.
--
-- Purely additive: a new table, no change to dashboard_widgets.

-- CreateTable
CREATE TABLE "dashboard_widget_presets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "DashboardWidgetType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widget_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboard_widget_presets_user_id_type_idx" ON "dashboard_widget_presets"("user_id", "type");

-- CreateIndex: one name per (user, widget type) — the conflict the create/update
-- mutations surface as BAD_USER_INPUT, enforced here so a race can't slip past.
CREATE UNIQUE INDEX "dashboard_widget_presets_user_id_type_name_key" ON "dashboard_widget_presets"("user_id", "type", "name");

-- AddForeignKey
ALTER TABLE "dashboard_widget_presets" ADD CONSTRAINT "dashboard_widget_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
