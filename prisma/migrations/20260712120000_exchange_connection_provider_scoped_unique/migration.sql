-- PR #638 (Codex P1) — calendar connections ride ExchangeConnection with
-- provider 'google-cal'. The uniqueness key must be provider-scoped: a
-- calendar connect for an address that already has a mail connection (the
-- same Google account) must COEXIST with that row, not upsert over it and
-- tear down its tool connection. Widening the key is safe on existing data
-- (every (org, email) pair remains unique under (org, provider, email)).

DROP INDEX "exchange_connections_organization_id_mailbox_email_key";

CREATE UNIQUE INDEX "exchange_connections_organization_id_provider_mailbox_email_key"
  ON "exchange_connections"("organization_id", "provider", "mailbox_email");
