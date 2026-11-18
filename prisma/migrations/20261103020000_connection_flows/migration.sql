-- #2913: where one GraphQL-started connect flow is (cor:dmo:080:04). Additive.
CREATE TABLE "connection_flows" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connection_id" TEXT,
    "failure_code" TEXT,
    "settled_at" TIMESTAMP(3),

    CONSTRAINT "connection_flows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "connection_flows_started_at_idx" ON "connection_flows"("started_at");

ALTER TABLE "connection_flows" ADD CONSTRAINT "connection_flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "connection_flows" ADD CONSTRAINT "connection_flows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_handoff_codes" ADD COLUMN "flow_id" TEXT;
