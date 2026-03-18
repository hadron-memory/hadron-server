-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('WORKSTATION', 'AGENT', 'AUTOMATION', 'CLOUD', 'IOT');

-- CreateEnum
CREATE TYPE "SubscriptionType" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCING', 'OK', 'ERROR');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('GITHUB', 'EMAIL');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "MemoryLogEventType" AS ENUM ('SYNC', 'LICENSE', 'EDGE', 'OTHER');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER,
    "githubUsername" TEXT,
    "identityProvider" "IdentityProvider",
    "name" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "roles" "Role"[] DEFAULT ARRAY['READER']::"Role"[],
    "maxReferrals" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "isPersonal" BOOLEAN NOT NULL DEFAULT false,
    "githubInstallationId" INTEGER,
    "githubAppId" TEXT,
    "githubAppPrivateKeyEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "canInvite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "clientType" "ClientType" NOT NULL DEFAULT 'WORKSTATION',
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "apiKeyShown" BOOLEAN NOT NULL DEFAULT false,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "namespace" TEXT,
    "description" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_bundle_subscriptions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "subscriptionType" "SubscriptionType" NOT NULL DEFAULT 'READ_ONLY',
    "trainingMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "client_bundle_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "sourceTokenEncrypted" TEXT,
    "sourceTokenExpiresAt" TIMESTAMP(3),
    "readBranch" TEXT,
    "writeBranch" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "requiresLicense" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncError" TEXT,
    "pendingEdgeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alias" TEXT,
    "loc" TEXT NOT NULL,
    "isLink" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "content" TEXT,
    "contentHash" TEXT,
    "tokens" INTEGER,
    "tags" TEXT[],
    "namespace" TEXT NOT NULL,
    "ownerRepo" TEXT,
    "isRunnable" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edges" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_edges" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "pending_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "type" "SessionType" NOT NULL DEFAULT 'DEVELOPER',
    "clientId" TEXT,
    "repo" TEXT,
    "branch" TEXT,
    "prNumber" INTEGER,
    "customerId" TEXT,
    "language" TEXT,
    "plan" TEXT,
    "llmModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "turnCount" INTEGER,
    "errorCount" INTEGER,
    "parentSessionId" TEXT,
    "prevSessionId" TEXT,
    "summary" TEXT,
    "outcome" DOUBLE PRECISION,
    "outcomeRef" TEXT,
    "outcomeMeta" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "autoExpiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nodeLoc" TEXT,
    "nodeId" TEXT,
    "sessionId" TEXT,
    "clientId" TEXT,
    "actionArgs" JSONB,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_bundles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memory_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_bundle_items" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memory_bundle_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_licenses" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "licenseType" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "licenseKeys" TEXT[],
    "terms" TEXT NOT NULL,
    "activated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memory_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_subscriptions" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "licenseId" TEXT,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "activated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memory_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hadron_server" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "url" TEXT NOT NULL,
    "logLevel" "LogLevel" NOT NULL DEFAULT 'ERROR',
    "version" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "hadron_server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_log" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memoryId" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "server_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_log" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memoryId" TEXT,
    "sessionId" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "client_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_log" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "eventType" "MemoryLogEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "memory_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member_invitations" (
    "id" TEXT NOT NULL,
    "memberUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "org_member_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" TEXT NOT NULL,
    "senderUserId" TEXT,
    "organizationId" TEXT,
    "slug" TEXT NOT NULL,
    "userRole" "Role",
    "memberRole" "Role" NOT NULL DEFAULT 'READER',
    "newUserId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "githubUsername" TEXT,
    "phoneNumber" TEXT,
    "maxActivations" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitation_activations" (
    "id" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "user_invitation_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubUsername_key" ON "users"("githubUsername");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_domain_key" ON "organizations"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_githubInstallationId_key" ON "organizations"("githubInstallationId");

-- CreateIndex
CREATE INDEX "org_members_userId_idx" ON "org_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_organizationId_userId_key" ON "org_members"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organizationId_label_key" ON "clients"("organizationId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "clients_userId_label_key" ON "clients"("userId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "client_bundle_subscriptions_clientId_bundleId_key" ON "client_bundle_subscriptions"("clientId", "bundleId");

-- CreateIndex
CREATE INDEX "memories_organizationId_idx" ON "memories"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "memories_organizationId_name_key" ON "memories"("organizationId", "name");

-- CreateIndex
CREATE INDEX "nodes_loc_idx" ON "nodes"("loc");

-- CreateIndex
CREATE INDEX "nodes_namespace_idx" ON "nodes"("namespace");

-- CreateIndex
CREATE INDEX "nodes_memoryId_idx" ON "nodes"("memoryId");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_loc_memoryId_key" ON "nodes"("loc", "memoryId");

-- CreateIndex
CREATE INDEX "edges_targetId_idx" ON "edges"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "edges_sourceId_targetId_label_key" ON "edges"("sourceId", "targetId", "label");

-- CreateIndex
CREATE INDEX "pending_edges_targetId_idx" ON "pending_edges"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_edges_sourceId_targetId_key" ON "pending_edges"("sourceId", "targetId");

-- CreateIndex
CREATE INDEX "sessions_type_idx" ON "sessions"("type");

-- CreateIndex
CREATE INDEX "sessions_repo_idx" ON "sessions"("repo");

-- CreateIndex
CREATE INDEX "sessions_customerId_idx" ON "sessions"("customerId");

-- CreateIndex
CREATE INDEX "sessions_startedAt_idx" ON "sessions"("startedAt");

-- CreateIndex
CREATE INDEX "sessions_parentSessionId_idx" ON "sessions"("parentSessionId");

-- CreateIndex
CREATE INDEX "sessions_prevSessionId_idx" ON "sessions"("prevSessionId");

-- CreateIndex
CREATE INDEX "sessions_clientId_idx" ON "sessions"("clientId");

-- CreateIndex
CREATE INDEX "usage_events_nodeLoc_idx" ON "usage_events"("nodeLoc");

-- CreateIndex
CREATE INDEX "usage_events_type_idx" ON "usage_events"("type");

-- CreateIndex
CREATE INDEX "usage_events_createdAt_idx" ON "usage_events"("createdAt");

-- CreateIndex
CREATE INDEX "usage_events_sessionId_idx" ON "usage_events"("sessionId");

-- CreateIndex
CREATE INDEX "usage_events_clientId_idx" ON "usage_events"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "memory_bundles_organizationId_name_key" ON "memory_bundles"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "memory_bundle_items_bundleId_memoryId_key" ON "memory_bundle_items"("bundleId", "memoryId");

-- CreateIndex
CREATE INDEX "memory_subscriptions_organizationId_idx" ON "memory_subscriptions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "memory_subscriptions_memoryId_organizationId_key" ON "memory_subscriptions"("memoryId", "organizationId");

-- CreateIndex
CREATE INDEX "server_log_serverId_idx" ON "server_log"("serverId");

-- CreateIndex
CREATE INDEX "server_log_level_idx" ON "server_log"("level");

-- CreateIndex
CREATE INDEX "server_log_createdAt_idx" ON "server_log"("createdAt");

-- CreateIndex
CREATE INDEX "client_log_clientId_idx" ON "client_log"("clientId");

-- CreateIndex
CREATE INDEX "client_log_level_idx" ON "client_log"("level");

-- CreateIndex
CREATE INDEX "client_log_createdAt_idx" ON "client_log"("createdAt");

-- CreateIndex
CREATE INDEX "memory_log_memoryId_idx" ON "memory_log"("memoryId");

-- CreateIndex
CREATE INDEX "memory_log_level_idx" ON "memory_log"("level");

-- CreateIndex
CREATE INDEX "memory_log_eventType_idx" ON "memory_log"("eventType");

-- CreateIndex
CREATE INDEX "memory_log_createdAt_idx" ON "memory_log"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_slug_key" ON "user_invitations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_key" ON "email_verification_tokens"("token");

-- CreateIndex
CREATE INDEX "email_verification_tokens_email_idx" ON "email_verification_tokens"("email");

-- CreateIndex
CREATE INDEX "node_versions_nodeId_createdAt_idx" ON "node_versions"("nodeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pending_setups_userId_key" ON "pending_setups"("userId");

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_bundle_subscriptions" ADD CONSTRAINT "client_bundle_subscriptions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_bundle_subscriptions" ADD CONSTRAINT "client_bundle_subscriptions_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "memory_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_edges" ADD CONSTRAINT "pending_edges_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_prevSessionId_fkey" FOREIGN KEY ("prevSessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundles" ADD CONSTRAINT "memory_bundles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundle_items" ADD CONSTRAINT "memory_bundle_items_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "memory_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundle_items" ADD CONSTRAINT "memory_bundle_items_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_licenses" ADD CONSTRAINT "memory_licenses_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "memory_licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_log" ADD CONSTRAINT "server_log_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "hadron_server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_log" ADD CONSTRAINT "client_log_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_log" ADD CONSTRAINT "memory_log_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_invitations" ADD CONSTRAINT "org_member_invitations_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "org_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_invitations" ADD CONSTRAINT "org_member_invitations_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitation_activations" ADD CONSTRAINT "user_invitation_activations_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "user_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitation_activations" ADD CONSTRAINT "user_invitation_activations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_setups" ADD CONSTRAINT "pending_setups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
