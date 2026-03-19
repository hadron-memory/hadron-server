/*
  Warnings:

  - You are about to drop the column `is_personal` on the `organizations` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "is_personal",
ADD COLUMN     "is_visible" BOOLEAN;
