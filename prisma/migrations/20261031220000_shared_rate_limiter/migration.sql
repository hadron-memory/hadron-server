CREATE TABLE rate_limit_policies (
 field_class text PRIMARY KEY, principal_limit integer NOT NULL CHECK(principal_limit > 0),
 key_limit integer NOT NULL CHECK(key_limit > 0), ip_limit integer NOT NULL CHECK(ip_limit > 0),
 window_seconds integer NOT NULL CHECK(window_seconds IN (60,900,3600)), retention_seconds integer NOT NULL DEFAULT 86400 CHECK(retention_seconds = 86400),
 enforcement_mode text NOT NULL DEFAULT 'LOG_ONLY' CHECK(enforcement_mode IN ('LOG_ONLY','ENFORCING')),
 version integer NOT NULL DEFAULT 1, updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE rate_limit_buckets (
 id text PRIMARY KEY, field_class text NOT NULL, dimension text NOT NULL, subject text NOT NULL,
 window_start timestamp(3) NOT NULL, used bigint NOT NULL CHECK(used >= 0), expires_at timestamp(3) NOT NULL,
 UNIQUE(field_class,dimension,subject,window_start)
);
CREATE INDEX rate_limit_buckets_expires_at_idx ON rate_limit_buckets(expires_at);
CREATE TABLE rate_limit_manifests (id text PRIMARY KEY, key_ids text[] NOT NULL, fingerprints jsonb NOT NULL, overlap_started_at timestamp(3), version integer NOT NULL DEFAULT 1);
CREATE TABLE rate_limit_policy_audits (id text PRIMARY KEY, field_class text NOT NULL, actor_id text NOT NULL, before jsonb NOT NULL, after jsonb NOT NULL, change_reference text NOT NULL, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
