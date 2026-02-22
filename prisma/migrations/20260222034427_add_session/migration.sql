/*
  Warnings:

  - You are about to drop the column `success` on the `UsageEvent` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "UsageEvent" DROP COLUMN "success";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'developer',
    "clientId" TEXT,
    "repo" TEXT,
    "branch" TEXT,
    "prNumber" INTEGER,
    "customerId" TEXT,
    "language" TEXT,
    "summary" TEXT,
    "outcome" DOUBLE PRECISION,
    "outcomeRef" TEXT,
    "outcomeMeta" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "autoExpiredAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_type_idx" ON "Session"("type");

-- CreateIndex
CREATE INDEX "Session_repo_idx" ON "Session"("repo");

-- CreateIndex
CREATE INDEX "Session_customerId_idx" ON "Session"("customerId");

-- CreateIndex
CREATE INDEX "Session_startedAt_idx" ON "Session"("startedAt");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
