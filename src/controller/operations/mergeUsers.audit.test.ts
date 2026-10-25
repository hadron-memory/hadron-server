import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../../lib/id.js';
import { AUDIT_USER_COLUMNS, DIRECT_USER_REFERENCES } from './mergeUsers.js';

type AuditColumn = { table_name: string; column_name: string };

// Ordinary audit stamps follow the surviving identity (spec 048). Compiled
// automation identities are sealed consent/provenance snapshots instead:
// rewriting them would violate the immutable evidence and silently change its
// historical actor. Source Users are soft-deleted, so these remain resolvable
// history; execution must fail closed for a merged-away run-as/signer.
// The behavioral user-merge test in automation/versions.test.ts pins this.
const EXEMPT_AUDIT_COLUMNS = new Set([
  'automation_versions.published_by',
  'automation_versions.approved_by',
  'automation_versions.revoked_by',
  // #1705 — the agent team event stream is append-only (a trigger refuses the
  // UPDATE a retarget would need): who acted, and who acknowledged an alarm,
  // is a sealed record of the time. Pinned in agentTasks/agentTasks.test.ts.
  'agent_team_events.actor_user_id',
  'agent_team_events.acknowledged_by_user_id',
  // #2441 — adoption events are append-only history of who approved, declined
  // or revoked an automation; sealed like the stream above.
  'automation_adoption_events.actor_user_id',
  // #1632 — signing requests and signature records are guarded history (a
  // trigger refuses any change to a request's pins and any update of a
  // record): who asked, who was named and who signed are sealed. A merged-away
  // named signer or requester fails closed (cannot sign or withdraw), the
  // automation run-as/signer rule above.
  'signing_requests.requester_user_id',
  'signing_requests.named_signer_id',
  'node_signatures.signer_id',
]);

function coveredPairs(registry: Readonly<Record<string, readonly string[]>>): Set<string> {
  return new Set(Object.entries(registry).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)));
}

function uncoveredPairs(schemaPairs: ReadonlySet<string>, registry: Readonly<Record<string, readonly string[]>>): string[] {
  const covered = coveredPairs(registry);
  return [...schemaPairs].filter((pair) => !covered.has(pair) && !EXEMPT_AUDIT_COLUMNS.has(pair)).sort();
}

describe('mergeUsers audit actor registry', () => {
  beforeEach(async () => {
    await cleanDb(db);
  });

  it('covers every migrated-schema audit column with no stale exemptions', async () => {
    const columns = await db.$queryRaw<AuditColumn[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name IN ('created_by', 'updated_by', 'deleted_by', 'revoked_by')
          OR (table_name = 'automation_versions' AND column_name IN ('published_by', 'approved_by'))
          OR (table_name = 'agent_tasks' AND column_name = 'assigned_by')
          OR (table_name = 'workers' AND column_name = 'retired_by')
          OR (table_name = 'ticker_subscriptions' AND column_name IN ('ended_by', 'via_grant_person_id', 'ended_via_grant_person_id'))
          OR (table_name = 'app_grants' AND column_name = 'granted_by')
          OR (table_name = 'app_key_scopes' AND column_name IN ('granted_by_user_id', 'revoked_by_user_id'))
          OR (table_name = 'agent_team_events' AND column_name IN ('actor_user_id', 'acknowledged_by_user_id'))
          OR (table_name = 'automation_adoption_events' AND column_name = 'actor_user_id')
          OR (table_name = 'signing_requests' AND column_name IN ('requester_user_id', 'named_signer_id'))
          OR (table_name = 'node_signatures' AND column_name = 'signer_id'))
    `;
    const schemaPairs = new Set(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
    const covered = coveredPairs(AUDIT_USER_COLUMNS);

    expect(uncoveredPairs(schemaPairs, AUDIT_USER_COLUMNS)).toEqual([]);
    // A stale registry entry or a stale exemption is also drift, not coverage.
    expect([...covered].filter((pair) => !schemaPairs.has(pair))).toEqual([]);
    expect([...EXEMPT_AUDIT_COLUMNS].filter((pair) => !schemaPairs.has(pair))).toEqual([]);
    expect([...covered].filter((pair) => EXEMPT_AUDIT_COLUMNS.has(pair))).toEqual([]);

    // Negative control: deleting a real handled entry must fail this guard.
    const omitted = {
      ...AUDIT_USER_COLUMNS,
      channels: AUDIT_USER_COLUMNS.channels.filter((column) => column !== 'created_by'),
    };
    expect(uncoveredPairs(schemaPairs, omitted)).toEqual(['channels.created_by']);
  });

  it('retargets source audit stamps without changing target or external actors, including soft-deleted rows', async () => {
    const [source, target, actor] = await Promise.all([
      db.user.create({ data: { handle: 'audit-merge-source' } }),
      db.user.create({ data: { handle: 'audit-merge-target' } }),
      db.user.create({ data: { handle: 'audit-merge-actor', roles: ['ADMIN'] } }),
    ]);
    await db.user.update({ where: { id: source.id }, data: { createdBy: source.id } });
    const stampedUser = await db.user.create({
      data: {
        handle: 'audit-stamped-user',
        createdBy: source.id,
        updatedBy: source.id,
        deletedBy: source.id,
      },
    });
    const unaffectedUser = await db.user.create({
      data: {
        handle: 'audit-unaffected-user',
        createdBy: target.id,
        updatedBy: 'github:external-actor',
        deletedBy: actor.id,
      },
    });
    const org = await db.organization.create({
      data: {
        name: 'Soft-deleted audit org',
        urn: 'audit-merge-org.test',
        createdBy: source.id,
        updatedBy: source.id,
        deletedBy: source.id,
        deletedAt: new Date(),
      },
    });
    const scope = await db.scope.create({
      data: {
        name: 'audit-merge-scope',
        organizationId: org.id,
        createdBy: source.id,
        updatedBy: source.id,
        deletedBy: source.id,
        deletedAt: new Date(),
      },
    });
    const sender = await db.resendSender.create({
      data: {
        organizationId: org.id,
        fromAddress: 'Audit <audit@example.test>',
        apiKeyEncrypted: 'fixture-only',
        createdBy: source.id,
        updatedBy: target.id,
      },
    });
    const secret = await db.secret.create({
      data: {
        ownerType: 'user',
        ownerId: target.id,
        name: 'audit-merge-secret',
        kind: 'generic',
        valueEncrypted: 'fixture-only',
        createdBy: source.id,
        updatedBy: 'app:external-actor',
      },
    });
    const widget = await db.dashboardWidget.create({
      data: {
        userId: target.id,
        type: 'MEMORY_STATS',
        createdBy: source.id,
        updatedBy: source.id,
      },
    });
    const alias = await db.urnAlias.create({
      data: {
        urn: 'hrn:org:audit-old.test',
        entityType: 'ORGANIZATION',
        entityId: org.id,
        reason: 'RENAME',
        createdBy: source.id,
      },
    });
    const app = await db.app.create({
      data: { organizationId: org.id, name: 'Audit App', urn: `${org.urn}:app` },
    });
    const agent = await db.agent.create({
      data: { organizationId: org.id, name: 'Audit Agent', urn: `${org.urn}:agent` },
    });
    const worker = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id,
        agentId: agent.id,
        name: 'Audit Worker',
        slug: 'audit-worker',
        createdBy: source.id,
        updatedBy: source.id,
      },
    });
    const memory = await db.memory.create({
      data: {
        organizationId: org.id,
        urn: `${org.urn}:channel-memory`,
        name: 'Audit Channel Memory',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    const root = await db.node.create({
      data: { memoryId: memory.id, loc: 'chats:team', name: 'team', nodeType: 'chat' },
    });
    const channel = await db.channel.create({
      data: {
        memoryId: memory.id,
        loc: root.loc,
        name: 'Audit Channel',
        chatRootNodeId: root.id,
        createdBy: source.id,
        updatedBy: source.id,
        deletedBy: source.id,
        deletedAt: new Date(),
      },
    });
    const register = await db.registerEntry.create({
      data: {
        organizationId: org.id,
        channelId: channel.id,
        role: 'BOTH',
        createdBy: source.id,
        updatedBy: source.id,
        deletedBy: source.id,
        deletedAt: new Date(),
      },
    });

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id, actorUserId: actor.id });

    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
      deletedBy: target.id,
      deletedAt: expect.any(Date),
    });
    expect(await db.scope.findUniqueOrThrow({ where: { id: scope.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
      deletedBy: target.id,
      deletedAt: expect.any(Date),
    });
    expect(await db.resendSender.findUniqueOrThrow({ where: { id: sender.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
    });
    expect(await db.secret.findUniqueOrThrow({ where: { id: secret.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: 'app:external-actor',
    });
    expect(await db.dashboardWidget.findUniqueOrThrow({ where: { id: widget.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
    });
    expect(await db.urnAlias.findUniqueOrThrow({ where: { id: alias.id } })).toMatchObject({
      createdBy: target.id,
    });
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
    });
    expect(await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
      deletedBy: target.id,
      deletedAt: expect.any(Date),
    });
    expect(await db.registerEntry.findUniqueOrThrow({ where: { id: register.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
      deletedBy: target.id,
      deletedAt: expect.any(Date),
    });
    expect(await db.user.findUniqueOrThrow({ where: { id: stampedUser.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: target.id,
      deletedBy: target.id,
    });
    expect(await db.user.findUniqueOrThrow({ where: { id: unaffectedUser.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: 'github:external-actor',
      deletedBy: actor.id,
    });
    expect(await db.user.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({
      createdBy: target.id,
      updatedBy: actor.id,
      deletedBy: actor.id,
      deletedAt: expect.any(Date),
    });
  });

  // #1416 (R204): the action-specific actor columns the generic created/updated/deleted/revoked guard does not
  // cover. `workers.retired_by` rides AUDIT_USER_COLUMNS (checked by the test above); the impersonation columns
  // are rewritten by a dedicated statement in mergeUsers, in a fixed order after the live sessions are ended.
  // This list is semantic: it names the columns whose value IS a User.id, never every `_by` column.
  const IMPERSONATION_USER_COLUMNS = new Set([
    'impersonation_sessions.admin_user_id',
    'impersonation_sessions.target_user_id',
    'impersonation_sessions.ended_by',
  ]);

  it('classifies every User-valued column of impersonation_sessions and workers.retired_by', async () => {
    const columns = await db.$queryRaw<AuditColumn[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'impersonation_sessions'
        AND (column_name LIKE '%\_by' OR column_name LIKE '%\_user\_id' OR column_name LIKE '%\_by\_id')
    `;
    const schemaPairs = new Set(columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`));
    // A new actor or participant column on the audit table fails here until a ruling classifies it.
    expect([...schemaPairs].sort()).toEqual([...IMPERSONATION_USER_COLUMNS].sort());
    expect(AUDIT_USER_COLUMNS.workers).toContain('retired_by');
    // The dedicated statement owns these; the generic loops must not also touch them.
    expect(Object.keys(AUDIT_USER_COLUMNS)).not.toContain('impersonation_sessions');
    expect(DIRECT_USER_REFERENCES.filter(([table]) => table === 'impersonation_sessions')).toEqual([]);
  });

  // `minted_by` / `validate_by` look like actor columns and are not. Each is classified here by what it holds;
  // a new column of either name fails until it is classified too.
  const MINTED_VALIDATE_BY_CLASSIFICATION: Readonly<Record<string, string>> = {
    // The node's mint attribution: a User.id, rewritten by DIRECT_USER_REFERENCES.
    'nodes.minted_by': 'user-id: follows the survivor',
    // ctx.userId ?? ctx.clientId ?? 'unknown' — mixed User / client / sentinel provenance, no FK, no authority
    // consumer. Issuance history; R204 leaves it where it was written.
    'action_tickets.minted_by': 'mixed provenance: preserved',
    // ContentValidator enums (configuration), not identities.
    'node_role_rules.validate_by': 'enum: not an actor',
    'memory_config_template_rules.validate_by': 'enum: not an actor',
  };

  it('classifies every minted_by / validate_by column and leaves the mixed ones out of the rewrite', async () => {
    const columns = await db.$queryRaw<AuditColumn[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('minted_by', 'validate_by')
    `;
    const schemaPairs = columns.map(({ table_name, column_name }) => `${table_name}.${column_name}`).sort();
    expect(schemaPairs).toEqual(Object.keys(MINTED_VALIDATE_BY_CLASSIFICATION).sort());

    const rewritten = new Set([
      ...DIRECT_USER_REFERENCES.map(([table, column]) => `${table}.${column}`),
      ...coveredPairs(AUDIT_USER_COLUMNS),
    ]);
    for (const [pair, kind] of Object.entries(MINTED_VALIDATE_BY_CLASSIFICATION)) {
      expect(rewritten.has(pair), pair).toBe(kind.startsWith('user-id'));
    }
  });

  it('keeps action_tickets.minted_by as written, whatever it holds', async () => {
    const [source, target, actor] = await Promise.all([
      db.user.create({ data: { handle: 'ticket-merge-source' } }),
      db.user.create({ data: { handle: 'ticket-merge-target' } }),
      db.user.create({ data: { handle: 'ticket-merge-actor', roles: ['ADMIN'] } }),
    ]);
    const org = await db.organization.create({ data: { name: 'Ticket merge org', urn: 'ticket-merge-org.test' } });
    const mint = async (mintedBy: string) => {
      const id = generateId();
      await db.actionTicket.create({ data: { id, organizationId: org.id, action: 'comm.outbound', mintedBy } });
      return id;
    };
    const ids = [await mint(source.id), await mint('client:some-app'), await mint('unknown')];

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id, actorUserId: actor.id });

    const rows = await db.actionTicket.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    expect(new Map(rows.map((r) => [r.id, r.mintedBy]))).toEqual(
      new Map([
        [ids[0], source.id],
        [ids[1], 'client:some-app'],
        [ids[2], 'unknown'],
      ]),
    );
  });
});
