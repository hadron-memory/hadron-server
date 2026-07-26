-- #788: dashboard widget placements gain height control and per-instance
-- settings for the portal's in-place editor. Additive — existing rows keep
-- their layout and get rowSpan 1 / no config.

-- AlterTable
ALTER TABLE "dashboard_widgets" ADD COLUMN "row_span" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "dashboard_widgets" ADD COLUMN "config" JSONB;
