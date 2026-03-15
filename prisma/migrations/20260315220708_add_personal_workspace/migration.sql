-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "isPersonal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "node_versions" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "loc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alias" TEXT,
    "description" TEXT,
    "content" TEXT,
    "tags" TEXT[],
    "editedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_setups" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "rawKeyEncrypted" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "node_versions_nodeId_createdAt_idx" ON "node_versions"("nodeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_setups_userId_key" ON "pending_setups"("userId");

-- AddForeignKey
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_setups" ADD CONSTRAINT "pending_setups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
