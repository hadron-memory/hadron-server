/*
  Warnings:

  - You are about to drop the column `role` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `ApiKey` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ADMIN', 'CONTRIBUTOR', 'READER');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('WORKSTATION', 'CLOUD', 'IOT', 'AGENT');

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "roles" "Role"[] DEFAULT ARRAY['READER']::"Role"[];

-- DropTable
DROP TABLE "ApiKey";

-- CreateTable
CREATE TABLE "PendingEdge" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "PendingEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "type" "ClientType" NOT NULL DEFAULT 'WORKSTATION',
    "description" TEXT,
    "roles" "Role"[] DEFAULT ARRAY['READER']::"Role"[],
    "namespace" TEXT,
    "organizationId" TEXT,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "githubInstallationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'READER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HadronGraph" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "readBranch" TEXT,
    "writeBranch" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "version" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HadronGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientGraphSubscription" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientGraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HadronGraphSubscription" (
    "id" TEXT NOT NULL,
    "graphId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'READER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HadronGraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingEdge_targetId_idx" ON "PendingEdge"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingEdge_sourceId_targetId_key" ON "PendingEdge"("sourceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_label_key" ON "Client"("label");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_githubInstallationId_key" ON "Organization"("githubInstallationId");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "HadronGraph_organizationId_idx" ON "HadronGraph"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "HadronGraph_organizationId_name_key" ON "HadronGraph"("organizationId", "name");

-- CreateIndex
CREATE INDEX "ClientGraphSubscription_graphId_idx" ON "ClientGraphSubscription"("graphId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientGraphSubscription_clientId_graphId_key" ON "ClientGraphSubscription"("clientId", "graphId");

-- CreateIndex
CREATE INDEX "HadronGraphSubscription_organizationId_idx" ON "HadronGraphSubscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "HadronGraphSubscription_graphId_organizationId_key" ON "HadronGraphSubscription"("graphId", "organizationId");

-- AddForeignKey
ALTER TABLE "PendingEdge" ADD CONSTRAINT "PendingEdge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HadronGraph" ADD CONSTRAINT "HadronGraph_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientGraphSubscription" ADD CONSTRAINT "ClientGraphSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientGraphSubscription" ADD CONSTRAINT "ClientGraphSubscription_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "HadronGraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HadronGraphSubscription" ADD CONSTRAINT "HadronGraphSubscription_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "HadronGraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HadronGraphSubscription" ADD CONSTRAINT "HadronGraphSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
