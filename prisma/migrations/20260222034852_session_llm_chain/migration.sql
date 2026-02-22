-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "errorCount" INTEGER,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "llmModel" TEXT,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "parentSessionId" TEXT,
ADD COLUMN     "prevSessionId" TEXT,
ADD COLUMN     "turnCount" INTEGER;

-- CreateIndex
CREATE INDEX "Session_parentSessionId_idx" ON "Session"("parentSessionId");

-- CreateIndex
CREATE INDEX "Session_prevSessionId_idx" ON "Session"("prevSessionId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_prevSessionId_fkey" FOREIGN KEY ("prevSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
