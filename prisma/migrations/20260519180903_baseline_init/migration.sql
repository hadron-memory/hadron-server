-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER');

-- CreateEnum
CREATE TYPE "AppMembershipRole" AS ENUM ('OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER');

-- CreateEnum
CREATE TYPE "AppType" AS ENUM ('WORKSTATION', 'CHATBOT', 'AGENT', 'AUTOMATION', 'CLOUD', 'IOT');

-- CreateEnum
CREATE TYPE "SubscriptionType" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCING', 'OK', 'ERROR');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('GITHUB', 'EMAIL', 'APP', 'GOOGLE', 'MICROSOFT');

-- CreateEnum
CREATE TYPE "CreateUserPermission" AS ENUM ('DENY', 'EXPLICIT', 'IMPLICIT');

-- CreateEnum
CREATE TYPE "IdentifyUserMethod" AS ENUM ('USER_ID', 'SECRET');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('ASSISTANT', 'CHATBOT');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "MemoryLogEventType" AS ENUM ('SYNC', 'LICENSE', 'EDGE', 'OTHER');

-- CreateEnum
CREATE TYPE "MemoryVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'ORGANIZATION', 'PERSONAL', 'GROUP');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('KNOWLEDGE', 'AGENT_SYSTEM');

-- CreateEnum
CREATE TYPE "MemoryClass" AS ENUM ('system', 'app', 'knowledge', 'personal', 'group');

-- CreateEnum
CREATE TYPE "MemoryShareRole" AS ENUM ('reader', 'writer');

-- CreateEnum
CREATE TYPE "MemoryMemberRole" AS ENUM ('reader', 'writer', 'owner');

-- CreateEnum
CREATE TYPE "AssetScanStatus" AS ENUM ('PENDING', 'CLEAN', 'BLOCKED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "handle" TEXT,
    "github_id" INTEGER,
    "github_username" TEXT,
    "identity_provider" "IdentityProvider",
    "external_id" TEXT,
    "external_app_id" TEXT,
    "linked_at" TIMESTAMP(3),
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
    "urn" TEXT NOT NULL,
    "is_visible" BOOLEAN,
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
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "app_id" TEXT,
    "user_id" TEXT,
    "user_memory_of_agent_id" TEXT,
    "urn" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_description" TEXT,
    "description" TEXT,
    "tags" TEXT[],
    "license" TEXT,
    "category_0" TEXT,
    "category_1" TEXT,
    "category_2" TEXT,
    "icon_url" TEXT,
    "hero_url" TEXT,
    "home_url" TEXT,
    "source" TEXT,
    "source_token_encrypted" TEXT,
    "source_token_expires_at" TIMESTAMP(3),
    "read_branch" TEXT,
    "write_branch" TEXT,
    "visibility" "MemoryVisibility" NOT NULL DEFAULT 'PRIVATE',
    "type" "MemoryType" NOT NULL DEFAULT 'KNOWLEDGE',
    "is_encrypted" BOOLEAN NOT NULL DEFAULT false,
    "class" "MemoryClass" NOT NULL,
    "anonymous_expires_at" TIMESTAMP(3),
    "requires_license" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "sync_error" TEXT,
    "pending_edge_count" INTEGER NOT NULL DEFAULT 0,
    "accepts_uploads" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "urn_normalized_at" TIMESTAMP(3),
    "urn_migration_failed_reason" TEXT,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "scan_status" "AssetScanStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL DEFAULT 'info',
    "name" TEXT NOT NULL,
    "alias" TEXT,
    "loc" TEXT NOT NULL,
    "is_link" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "content" TEXT,
    "content_hash" TEXT,
    "tokens" INTEGER,
    "tags" TEXT[],
    "properties" JSONB,
    "data" JSONB,
    "seq" INTEGER,
    "owner_repo" TEXT,
    "is_runnable" BOOLEAN,
    "llm_model" TEXT,
    "ai_agent" TEXT,
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
    "condition" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB,
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
    "app_id" TEXT,
    "user_id" TEXT,
    "agent_id" TEXT,
    "memory_id" TEXT,
    "expires_at" TIMESTAMP(3),
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
    "app_id" TEXT,
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
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "urn" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system_prompt" TEXT,
    "system_memory_id" TEXT,
    "visibility" "MemoryVisibility" NOT NULL DEFAULT 'PRIVATE',
    "type" "AgentType" NOT NULL DEFAULT 'ASSISTANT',
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "ai_api_key_encrypted" TEXT,
    "ai_api_key_preview" TEXT,
    "published_revision_loc" TEXT,
    "editor_lock_user_id" TEXT,
    "editor_lock_expires_at" TIMESTAMP(3),
    "properties" JSONB,
    "memory_provisioning" JSONB NOT NULL DEFAULT '{"appMemory": "shared"}',
    "installation_policy" JSONB NOT NULL DEFAULT '{"maxMembers": "unlimited", "memberRoles": ["owner"]}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "urn_normalized_at" TIMESTAMP(3),
    "urn_migration_failed_reason" TEXT,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory_items" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'read',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "agent_memory_items_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "server_log_pkey" PRIMARY KEY ("id")
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
    "alias" TEXT,
    "description" TEXT,
    "content" TEXT,
    "tags" TEXT[],
    "edited_by" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_setups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "raw_key_encrypted" TEXT NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_setups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "mailbox_email" TEXT NOT NULL,
    "display_name" TEXT,
    "refresh_token_encrypted" TEXT NOT NULL,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "last_sync_at" TIMESTAMP(3),
    "last_error" TEXT,
    "webhook_subscription_id" TEXT,
    "webhook_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "exchange_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waiting_list" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "requested_features" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waiting_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apps" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "urn" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "create_user_permission" "CreateUserPermission" NOT NULL DEFAULT 'EXPLICIT',
    "identify_user_method" "IdentifyUserMethod" NOT NULL DEFAULT 'USER_ID',
    "session_timeout_seconds" INTEGER NOT NULL DEFAULT 900,
    "anonymous_ttl_days" INTEGER NOT NULL DEFAULT 7,
    "app_type" "AppType" NOT NULL DEFAULT 'WORKSTATION',
    "role" "AppMembershipRole" NOT NULL DEFAULT 'READER',
    "description" TEXT,
    "system_prompt" TEXT,
    "agent_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "ai_api_key_encrypted" TEXT,
    "expires_at" TIMESTAMP(3),
    "training_mode" BOOLEAN NOT NULL DEFAULT false,
    "surfaces" TEXT[] DEFAULT ARRAY['chat']::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    "uninstalled_at" TIMESTAMP(3),
    "urn_normalized_at" TIMESTAMP(3),
    "urn_migration_failed_reason" TEXT,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_keys" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_preview" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "app_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_members" (
    "app_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "app_members_pkey" PRIMARY KEY ("app_id","user_id")
);

-- CreateTable
CREATE TABLE "agent_org_grants" (
    "org_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "agent_org_grants_pkey" PRIMARY KEY ("org_id","agent_id")
);

-- CreateTable
CREATE TABLE "agent_imports" (
    "parent_agent_id" TEXT NOT NULL,
    "imported_agent_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "agent_org_grant_org_id" TEXT NOT NULL,
    "agent_org_grant_agent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "agent_imports_pkey" PRIMARY KEY ("parent_agent_id","imported_agent_id")
);

-- CreateTable
CREATE TABLE "agent_subscriptions" (
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMPTZ,
    "updated_by" TEXT,

    CONSTRAINT "agent_subscriptions_pkey" PRIMARY KEY ("user_id","agent_id")
);

-- CreateTable
CREATE TABLE "app_log" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "memory_id" TEXT,
    "session_id" TEXT,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "app_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_agents" (
    "app_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "app_agents_pkey" PRIMARY KEY ("app_id","agent_id")
);

-- CreateTable
CREATE TABLE "memory_shares" (
    "memory_id" TEXT NOT NULL,
    "grantee_id" TEXT NOT NULL,
    "grantor_id" TEXT NOT NULL,
    "role" "MemoryShareRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "memory_shares_pkey" PRIMARY KEY ("memory_id","grantee_id")
);

-- CreateTable
CREATE TABLE "memory_members" (
    "memory_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "MemoryMemberRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_at" TIMESTAMP(3),
    "updated_by" TEXT,

    CONSTRAINT "memory_members_pkey" PRIMARY KEY ("memory_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_handle_key" ON "users"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_username_key" ON "users"("github_username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_external_app_id_external_id_key" ON "users"("external_app_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_urn_key" ON "organizations"("urn");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_github_installation_id_key" ON "organizations"("github_installation_id");

-- CreateIndex
CREATE INDEX "org_members_user_id_idx" ON "org_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_members_organization_id_user_id_key" ON "org_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memories_urn_key" ON "memories"("urn");

-- CreateIndex
CREATE INDEX "memories_organization_id_idx" ON "memories"("organization_id");

-- CreateIndex
CREATE INDEX "memories_user_memory_of_agent_id_idx" ON "memories"("user_memory_of_agent_id");

-- CreateIndex
CREATE INDEX "memories_anonymous_expires_at_idx" ON "memories"("anonymous_expires_at");

-- CreateIndex
CREATE INDEX "memories_user_id_idx" ON "memories"("user_id");

-- CreateIndex
CREATE INDEX "memories_app_id_idx" ON "memories"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storage_key_key" ON "assets"("storage_key");

-- CreateIndex
CREATE INDEX "assets_memory_id_scan_status_uploaded_at_idx" ON "assets"("memory_id", "scan_status", "uploaded_at" DESC);

-- CreateIndex
CREATE INDEX "nodes_loc_idx" ON "nodes"("loc");

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
CREATE INDEX "sessions_app_id_user_id_idx" ON "sessions"("app_id", "user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "usage_events_node_loc_idx" ON "usage_events"("node_loc");

-- CreateIndex
CREATE INDEX "usage_events_type_idx" ON "usage_events"("type");

-- CreateIndex
CREATE INDEX "usage_events_created_at_idx" ON "usage_events"("created_at");

-- CreateIndex
CREATE INDEX "usage_events_session_id_idx" ON "usage_events"("session_id");

-- CreateIndex
CREATE INDEX "usage_events_app_id_idx" ON "usage_events"("app_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_urn_key" ON "agents"("urn");

-- CreateIndex
CREATE UNIQUE INDEX "agent_memory_items_agent_id_memory_id_key" ON "agent_memory_items"("agent_id", "memory_id");

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

-- CreateIndex
CREATE INDEX "exchange_connections_user_id_idx" ON "exchange_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_connections_organization_id_mailbox_email_key" ON "exchange_connections"("organization_id", "mailbox_email");

-- CreateIndex
CREATE INDEX "waiting_list_email_idx" ON "waiting_list"("email");

-- CreateIndex
CREATE INDEX "apps_organization_id_idx" ON "apps"("organization_id");

-- CreateIndex
CREATE INDEX "apps_urn_idx" ON "apps"("urn");

-- CreateIndex
CREATE UNIQUE INDEX "app_keys_key_hash_key" ON "app_keys"("key_hash");

-- CreateIndex
CREATE INDEX "app_keys_app_id_idx" ON "app_keys"("app_id");

-- CreateIndex
CREATE INDEX "app_members_user_id_idx" ON "app_members"("user_id");

-- CreateIndex
CREATE INDEX "agent_org_grants_agent_id_idx" ON "agent_org_grants"("agent_id");

-- CreateIndex
CREATE INDEX "agent_imports_imported_agent_id_idx" ON "agent_imports"("imported_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_imports_parent_agent_id_position_key" ON "agent_imports"("parent_agent_id", "position");

-- CreateIndex
CREATE INDEX "agent_subscriptions_agent_id_idx" ON "agent_subscriptions"("agent_id");

-- CreateIndex
CREATE INDEX "app_log_app_id_idx" ON "app_log"("app_id");

-- CreateIndex
CREATE INDEX "app_log_app_id_created_at_idx" ON "app_log"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "app_log_level_idx" ON "app_log"("level");

-- CreateIndex
CREATE INDEX "app_log_created_at_idx" ON "app_log"("created_at");

-- CreateIndex
CREATE INDEX "app_agents_agent_id_idx" ON "app_agents"("agent_id");

-- CreateIndex
CREATE INDEX "memory_shares_grantee_id_idx" ON "memory_shares"("grantee_id");

-- CreateIndex
CREATE INDEX "memory_shares_grantor_id_idx" ON "memory_shares"("grantor_id");

-- CreateIndex
CREATE INDEX "memory_members_user_id_idx" ON "memory_members"("user_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_external_app_id_fkey" FOREIGN KEY ("external_app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_memory_of_agent_id_fkey" FOREIGN KEY ("user_memory_of_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_edges" ADD CONSTRAINT "pending_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_fkey" FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_prev_session_id_fkey" FOREIGN KEY ("prev_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_items" ADD CONSTRAINT "agent_memory_items_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_memory_items" ADD CONSTRAINT "agent_memory_items_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "pending_setups" ADD CONSTRAINT "pending_setups_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_connections" ADD CONSTRAINT "exchange_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_keys" ADD CONSTRAINT "app_keys_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_members" ADD CONSTRAINT "app_members_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_members" ADD CONSTRAINT "app_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_org_grants" ADD CONSTRAINT "agent_org_grants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_org_grants" ADD CONSTRAINT "agent_org_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_parent_agent_id_fkey" FOREIGN KEY ("parent_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_imported_agent_id_fkey" FOREIGN KEY ("imported_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_agent_org_grant_org_id_agent_org_grant_agent_fkey" FOREIGN KEY ("agent_org_grant_org_id", "agent_org_grant_agent_id") REFERENCES "agent_org_grants"("org_id", "agent_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_log" ADD CONSTRAINT "app_log_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agents" ADD CONSTRAINT "app_agents_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_agents" ADD CONSTRAINT "app_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_shares" ADD CONSTRAINT "memory_shares_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_shares" ADD CONSTRAINT "memory_shares_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_shares" ADD CONSTRAINT "memory_shares_grantor_id_fkey" FOREIGN KEY ("grantor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_members" ADD CONSTRAINT "memory_members_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_members" ADD CONSTRAINT "memory_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Post-baseline appendix ─────────────────────────────────────────────
-- The Prisma schema language can't express the following DDL, but prod
-- relies on it. This appendix recreates the state that pre-baseline
-- migrations (005-agent-subscription, 008-agent-installation, 021-urn,
-- 023-app-shape, and the staged-assets work) installed. It must stay in
-- sync with `prisma/post-push.sql`, which is the dev/test `db push`
-- equivalent.

-- NOT NULL on agents.surfaces / apps.surfaces. Prisma 6 emits `text[]`
-- without NOT NULL even when the Prisma-level field is non-optional
-- (arrays default to `[]` at the client layer so NULL never appears in
-- practice, but the migrations explicitly tightened the column).
ALTER TABLE "agents" ALTER COLUMN "surfaces" SET NOT NULL;
ALTER TABLE "apps"   ALTER COLUMN "surfaces" SET NOT NULL;

-- Replace the non-partial indexes Prisma emitted for `memories.user_id`
-- and the `(external_app_id, external_id)` uniqueness with their partial
-- equivalents — partial indexes are smaller (only the rows where the
-- column matters) and match prod's actual indexes.
DROP INDEX IF EXISTS "memories_user_id_idx";
CREATE INDEX "memories_user_id_idx" ON "memories" USING btree (user_id) WHERE (user_id IS NOT NULL);

DROP INDEX IF EXISTS "users_external_app_id_external_id_key";
CREATE UNIQUE INDEX "users_external_app_id_external_id_key" ON "users" USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL);

-- Prod-only partial indexes (supporting URN-migration sweep + staged
-- assets + active-app uniqueness).
CREATE INDEX "agents_urn_migration_pending_idx"   ON "agents"   USING btree (id) WHERE ((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL));
CREATE INDEX "apps_urn_migration_pending_idx"     ON "apps"     USING btree (id) WHERE ((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL));
CREATE INDEX "memories_urn_migration_pending_idx" ON "memories" USING btree (id) WHERE ((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL));
CREATE UNIQUE INDEX "apps_urn_active_uniq"        ON "apps"     USING btree (urn) WHERE (uninstalled_at IS NULL);
CREATE INDEX "assets_staged_uploaded_at_idx"      ON "assets"   USING btree (uploaded_at) WHERE (memory_id IS NULL);
CREATE INDEX "assets_uploaded_by_staged_idx"      ON "assets"   USING btree (uploaded_by, uploaded_at DESC) WHERE (memory_id IS NULL);

-- CHECK constraints on `memories`. These are the canonical, current
-- versions per spec 023-app-shape. (NOTE: prod is currently running the
-- pre-023 form of `chk_memory_class_app_id` — missing the 'group' class
-- in the second IN list — because migration 023_app_shape_additions's
-- ALTER didn't take effect. That drift is being addressed in a separate
-- follow-up migration, NOT this baseline.)
ALTER TABLE "memories"
  ADD CONSTRAINT "chk_personal_visibility_user"
  CHECK (("visibility" = 'PERSONAL') = ("user_id" IS NOT NULL));

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_class_app_id"
  CHECK (
    (class IN ('app', 'personal') AND app_id IS NOT NULL)
    OR (class IN ('system', 'knowledge', 'group') AND app_id IS NULL)
  );

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_group_visibility"
  CHECK (
    (class = 'group' AND visibility = 'GROUP')
    OR (class <> 'group' AND visibility <> 'GROUP')
  );

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_group_no_owner"
  CHECK (class <> 'group' OR user_id IS NULL);

ALTER TABLE "memories"
  ADD CONSTRAINT "chk_memory_personal_agent_id"
  CHECK (class <> 'personal' OR user_memory_of_agent_id IS NOT NULL);
