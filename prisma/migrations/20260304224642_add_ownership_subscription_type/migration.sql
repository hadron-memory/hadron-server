-- AlterTable
ALTER TABLE "ClientGraphSubscription" ADD COLUMN     "namespace" TEXT,
ADD COLUMN     "subscriptionType" TEXT NOT NULL DEFAULT 'READ_ONLY';

-- AlterTable
ALTER TABLE "HadronGraph" ADD COLUMN     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "ownerId" TEXT;

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HadronGraph" ADD CONSTRAINT "HadronGraph_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
