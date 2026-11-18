-- #3303: connection_flows.user_id and organization_id are ON DELETE CASCADE foreign keys with no index,
-- so deleting a user or an organization scanned the table. Additive, no data change.
CREATE INDEX "connection_flows_user_id_idx" ON "connection_flows"("user_id");
CREATE INDEX "connection_flows_organization_id_idx" ON "connection_flows"("organization_id");
