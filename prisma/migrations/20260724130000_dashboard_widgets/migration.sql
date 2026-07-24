-- #772: per-user dashboard widget selection. A user places widgets on their
-- /app/dashboard grid; this table persists that selection (one row per placed
-- widget, ordered by `position`). User-scoped config — owner-only, no org.

-- CreateEnum
CREATE TYPE "DashboardWidgetType" AS ENUM ('MEMORY_STATS');

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "DashboardWidgetType" NOT NULL,
    "span" INTEGER NOT NULL DEFAULT 4,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboard_widgets_user_id_position_idx" ON "dashboard_widgets"("user_id", "position");

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
