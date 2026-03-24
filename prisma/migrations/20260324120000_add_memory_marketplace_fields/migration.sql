-- AlterTable
ALTER TABLE "memories" ADD COLUMN "short_description" TEXT;
ALTER TABLE "memories" ADD COLUMN "description" TEXT;
ALTER TABLE "memories" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "memories" ADD COLUMN "license" TEXT;
ALTER TABLE "memories" ADD COLUMN "category_0" TEXT;
ALTER TABLE "memories" ADD COLUMN "category_1" TEXT;
ALTER TABLE "memories" ADD COLUMN "category_2" TEXT;
ALTER TABLE "memories" ADD COLUMN "icon_url" TEXT;
ALTER TABLE "memories" ADD COLUMN "hero_url" TEXT;
ALTER TABLE "memories" ADD COLUMN "home_url" TEXT;
