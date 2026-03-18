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
    "github_id" INTEGER,
    "github_username" TEXT,
    "identity_provider" "IdentityProvider",
    "name" TEXT,
    "email" TEXT,
    "avatar_url" TEXT,
    "roles" "Role"[] DEFAULT ARRAY['READER']::"Role"[],
    "max_referrals" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "github_installation_id" INTEGER,
    "github_app_id" TEXT,
    "github_app_private_key_encrypted" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_members" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "can_invite" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "org_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "client_type" "ClientType" NOT NULL DEFAULT 'WORKSTATION',
    "label" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "api_key_shown" BOOLEAN NOT NULL DEFAULT false,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "namespace" TEXT,
    "description" TEXT,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_bundle_subscriptions" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "subscription_type" "SubscriptionType" NOT NULL DEFAULT 'READ_ONLY',
    "training_mode" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "client_bundle_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT,
    "source_token_encrypted" TEXT,
    "source_token_expires_at" TIMESTAMP(3),
    "read_branch" TEXT,
    "write_branch" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "requires_license" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "sync_error" TEXT,
    "pending_edge_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alias" TEXT,
    "loc" TEXT NOT NULL,
    "is_link" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "content" TEXT,
    "content_hash" TEXT,
    "tokens" INTEGER,
    "tags" TEXT[],
    "namespace" TEXT NOT NULL,
    "owner_repo" TEXT,
    "is_runnable" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edges" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_edges" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "pending_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "type" "SessionType" NOT NULL DEFAULT 'DEVELOPER',
    "client_id" TEXT,
    "repo" TEXT,
    "branch" TEXT,
    "pr_number" INTEGER,
    "customer_id" TEXT,
    "language" TEXT,
    "plan" TEXT,
    "llm_model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "turn_count" INTEGER,
    "error_count" INTEGER,
    "parent_session_id" TEXT,
    "prev_session_id" TEXT,
    "summary" TEXT,
    "outcome" DOUBLE PRECISION,
    "outcome_ref" TEXT,
    "outcome_meta" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "auto_expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "node_loc" TEXT,
    "node_id" TEXT,
    "session_id" TEXT,
    "client_id" TEXT,
    "action_args" JSONB,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_bundles" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_bundle_items" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_bundle_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_licenses" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "license_type" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "license_keys" TEXT[],
    "terms" TEXT NOT NULL,
    "activated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_subscriptions" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "license_id" TEXT,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "activated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hadron_server" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "url" TEXT NOT NULL,
    "log_level" "LogLevel" NOT NULL DEFAULT 'ERROR',
    "version" TEXT,
    "last_heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "hadron_server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_log" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memory_id" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "server_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_log" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memory_id" TEXT,
    "session_id" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "client_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_log" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "event_type" "MemoryLogEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "memory_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_member_invitations" (
    "id" TEXT NOT NULL,
    "member_user_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'READER',
    "expires_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "org_member_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitations" (
    "id" TEXT NOT NULL,
    "sender_user_id" TEXT,
    "organization_id" TEXT,
    "slug" TEXT NOT NULL,
    "user_role" "Role",
    "member_role" "Role" NOT NULL DEFAULT 'READER',
    "new_user_id" TEXT,
    "name" TEXT,
    "email" TEXT,
    "github_username" TEXT,
    "phone_number" TEXT,
    "max_activations" INTEGER,
    "expires_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "user_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_invitation_activations" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "user_invitation_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_versions" (
    "id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "loc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alias" TEXT,
    "description" TEXT,
    "content" TEXT,
    "tags" TEXT[],
    "edited_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_setups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "raw_key_encrypted" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_username_key" ON "users"("github_username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_domain_key" ON "organizations"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_github_installation_id_key" ON "organizations"("github_installation_id");

-- CreateIndex
CREATE INDEX "org_members_user_id_idx" ON "org_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_organization_id_user_id_key" ON "org_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_organization_id_label_key" ON "clients"("organization_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "clients_user_id_label_key" ON "clients"("user_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "client_bundle_subscriptions_client_id_bundle_id_key" ON "client_bundle_subscriptions"("client_id", "bundle_id");

-- CreateIndex
CREATE INDEX "memories_organization_id_idx" ON "memories"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "memories_organization_id_name_key" ON "memories"("organization_id", "name");

-- CreateIndex
CREATE INDEX "nodes_loc_idx" ON "nodes"("loc");

-- CreateIndex
CREATE INDEX "nodes_namespace_idx" ON "nodes"("namespace");

-- CreateIndex
CREATE INDEX "nodes_memory_id_idx" ON "nodes"("memory_id");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_loc_memory_id_key" ON "nodes"("loc", "memory_id");

-- CreateIndex
CREATE INDEX "edges_target_id_idx" ON "edges"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "edges_source_id_target_id_label_key" ON "edges"("source_id", "target_id", "label");

-- CreateIndex
CREATE INDEX "pending_edges_target_id_idx" ON "pending_edges"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_edges_source_id_target_id_key" ON "pending_edges"("source_id", "target_id");

-- CreateIndex
CREATE INDEX "sessions_type_idx" ON "sessions"("type");

-- CreateIndex
CREATE INDEX "sessions_repo_idx" ON "sessions"("repo");

-- CreateIndex
CREATE INDEX "sessions_customer_id_idx" ON "sessions"("customer_id");

-- CreateIndex
CREATE INDEX "sessions_started_at_idx" ON "sessions"("started_at");

-- CreateIndex
CREATE INDEX "sessions_parent_session_id_idx" ON "sessions"("parent_session_id");

-- CreateIndex
CREATE INDEX "sessions_prev_session_id_idx" ON "sessions"("prev_session_id");

-- CreateIndex
CREATE INDEX "sessions_client_id_idx" ON "sessions"("client_id");

-- CreateIndex
CREATE INDEX "usage_events_node_loc_idx" ON "usage_events"("node_loc");

-- CreateIndex
CREATE INDEX "usage_events_type_idx" ON "usage_events"("type");

-- CreateIndex
CREATE INDEX "usage_events_created_at_idx" ON "usage_events"("created_at");

-- CreateIndex
CREATE INDEX "usage_events_session_id_idx" ON "usage_events"("session_id");

-- CreateIndex
CREATE INDEX "usage_events_client_id_idx" ON "usage_events"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_bundles_organization_id_name_key" ON "memory_bundles"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "memory_bundle_items_bundle_id_memory_id_key" ON "memory_bundle_items"("bundle_id", "memory_id");

-- CreateIndex
CREATE INDEX "memory_subscriptions_organization_id_idx" ON "memory_subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_subscriptions_memory_id_organization_id_key" ON "memory_subscriptions"("memory_id", "organization_id");

-- CreateIndex
CREATE INDEX "server_log_server_id_idx" ON "server_log"("server_id");

-- CreateIndex
CREATE INDEX "server_log_level_idx" ON "server_log"("level");

-- CreateIndex
CREATE INDEX "server_log_created_at_idx" ON "server_log"("created_at");

-- CreateIndex
CREATE INDEX "client_log_client_id_idx" ON "client_log"("client_id");

-- CreateIndex
CREATE INDEX "client_log_level_idx" ON "client_log"("level");

-- CreateIndex
CREATE INDEX "client_log_created_at_idx" ON "client_log"("created_at");

-- CreateIndex
CREATE INDEX "memory_log_memory_id_idx" ON "memory_log"("memory_id");

-- CreateIndex
CREATE INDEX "memory_log_level_idx" ON "memory_log"("level");

-- CreateIndex
CREATE INDEX "memory_log_event_type_idx" ON "memory_log"("event_type");

-- CreateIndex
CREATE INDEX "memory_log_created_at_idx" ON "memory_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_invitations_slug_key" ON "user_invitations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_key" ON "email_verification_tokens"("token");

-- CreateIndex
CREATE INDEX "email_verification_tokens_email_idx" ON "email_verification_tokens"("email");

-- CreateIndex
CREATE INDEX "node_versions_node_id_created_at_idx" ON "node_versions"("node_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pending_setups_user_id_key" ON "pending_setups"("user_id");

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_bundle_subscriptions" ADD CONSTRAINT "client_bundle_subscriptions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_bundle_subscriptions" ADD CONSTRAINT "client_bundle_subscriptions_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "memory_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_edges" ADD CONSTRAINT "pending_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_fkey" FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_prev_session_id_fkey" FOREIGN KEY ("prev_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundles" ADD CONSTRAINT "memory_bundles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundle_items" ADD CONSTRAINT "memory_bundle_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "memory_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_bundle_items" ADD CONSTRAINT "memory_bundle_items_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_licenses" ADD CONSTRAINT "memory_licenses_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_subscriptions" ADD CONSTRAINT "memory_subscriptions_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "memory_licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_log" ADD CONSTRAINT "server_log_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "hadron_server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_log" ADD CONSTRAINT "client_log_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_log" ADD CONSTRAINT "memory_log_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_invitations" ADD CONSTRAINT "org_member_invitations_member_user_id_fkey" FOREIGN KEY ("member_user_id") REFERENCES "org_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_member_invitations" ADD CONSTRAINT "org_member_invitations_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitation_activations" ADD CONSTRAINT "user_invitation_activations_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "user_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_invitation_activations" ADD CONSTRAINT "user_invitation_activations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_setups" ADD CONSTRAINT "pending_setups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
