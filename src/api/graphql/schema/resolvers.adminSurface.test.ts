/**
 * #510 — the headless admin surface, resolver layer.
 *
 * What this file pins:
 *   - One-shot schedules: cron XOR runAt on create; mode transitions on
 *     update; invalid runAt is a typed BAD_USER_INPUT.
 *   - quotaCounters materializes rows (seeded defaults) + setQuotaLimit
 *     stores the enforced value; app scope must belong to the org.
 *   - effectiveActionPolicy: per-layer verdicts off the standing chain.
 *   - Policy-link authoring: updateOrganization/updateApp validate shape;
 *     updateMyPolicy is self-service and clearable.
 *   - #501: addMemoryToAgent is an idempotent upsert (incl. soft-deleted
 *     resurrection); updateAgentMemoryRole types the missing-grant case.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

let org: { id: string; urn: string };
let app: { id: string };
let admin: { id: string };

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['READER'], userId: admin.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'adm-org', urn: 'adm-org' },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'adm-app', urn: 'adm-org::adm-app' },
  });
  admin = await db.user.create({
    data: { githubId: 9501, githubUsername: 'adm-admin', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
});

// ───── one-shot schedules ───────────────────────────────────────────────────

describe('createAgentSchedule — cron XOR runAt (#510)', () => {
  const base = {
    appRef: () => app.id,
    entryNodeUrn: 'adm-org::mem::tasks:brief',
  };

  it('creates a one-shot schedule: runAt seeds nextRunAt, cron stays null', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const s = await resolvers.Mutation.createAgentSchedule(
      {},
      { input: { appRef: base.appRef(), name: 'once', runAt: at, entryNodeUrn: base.entryNodeUrn } },
      adminCtx(),
    );
    expect(s.cron).toBeNull();
    expect(s.runAt?.toISOString()).toBe(at);
    expect(s.nextRunAt?.toISOString()).toBe(at);
  });

  it('rejects both cron and runAt, and neither', async () => {
    await expect(
      resolvers.Mutation.createAgentSchedule(
        {},
        {
          input: {
            appRef: base.appRef(), name: 'x', cron: '0 8 * * *',
            runAt: new Date().toISOString(), entryNodeUrn: base.entryNodeUrn,
          },
        },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      resolvers.Mutation.createAgentSchedule(
        {},
        { input: { appRef: base.appRef(), name: 'x', entryNodeUrn: base.entryNodeUrn } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects garbage runAt with a typed error', async () => {
    await expect(
      resolvers.Mutation.createAgentSchedule(
        {},
        { input: { appRef: base.appRef(), name: 'x', runAt: 'tomorrow-ish', entryNodeUrn: base.entryNodeUrn } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('update transitions: runAt → one-shot (clears cron); cron → recurring (clears runAt)', async () => {
    const s = await resolvers.Mutation.createAgentSchedule(
      {},
      { input: { appRef: base.appRef(), name: 'flip', cron: '0 8 * * *', entryNodeUrn: base.entryNodeUrn } },
      adminCtx(),
    );
    const at = new Date(Date.now() + 7_200_000).toISOString();
    const oneShot = await resolvers.Mutation.updateAgentSchedule(
      {},
      { id: s.id, input: { runAt: at } },
      adminCtx(),
    );
    expect(oneShot.cron).toBeNull();
    expect(oneShot.runAt?.toISOString()).toBe(at);
    expect(oneShot.nextRunAt?.toISOString()).toBe(at);
    const recurring = await resolvers.Mutation.updateAgentSchedule(
      {},
      { id: s.id, input: { cron: '30 9 * * 1' } },
      adminCtx(),
    );
    expect(recurring.runAt).toBeNull();
    expect(recurring.cron).toBe('30 9 * * 1');
    expect(recurring.nextRunAt).not.toBeNull();
  });
});

// ───── quota admin ──────────────────────────────────────────────────────────

describe('quotaCounters + setQuotaLimit (#510)', () => {
  it('materializes org rows on first view, seeded with defaults', async () => {
    const rows = await resolvers.Query.quotaCounters({}, { orgRef: org.urn }, adminCtx());
    const actions = rows.map((r: { action: string }) => r.action).sort();
    expect(actions).toEqual(['email.send', 'llm.tokens', 'run.execute', 'sms.send']);
    expect(rows.every((r: { scopeKind: string; used: number }) => r.scopeKind === 'org' && r.used === 0)).toBe(true);
  });

  it('includes app rows when appRef is given; foreign app is NOT_FOUND', async () => {
    const rows = await resolvers.Query.quotaCounters(
      {},
      { orgRef: org.id, appRef: app.id },
      adminCtx(),
    );
    expect(rows).toHaveLength(8); // 4 counter actions × {org, app} scope
    const otherOrg = await db.organization.create({
      data: { id: generateId(), name: 'other', urn: 'adm-other' },
    });
    const foreignApp = await db.app.create({
      data: { id: generateId(), organizationId: otherOrg.id, name: 'f', urn: 'adm-other::f' },
    });
    await expect(
      resolvers.Query.quotaCounters({}, { orgRef: org.id, appRef: foreignApp.id }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('setQuotaLimit stores the enforced value; 0 pauses the scope at the launch gate', async () => {
    const row = await resolvers.Mutation.setQuotaLimit(
      {},
      { input: { orgRef: org.id, appRef: app.id, action: 'run.execute', limit: 0 } },
      adminCtx(),
    );
    expect(row.limit).toBe(0);
    await expect(
      resolvers.Mutation.triggerAppRun(
        {},
        { input: { appRef: app.id, entryNodeUrn: 'adm-org::mem::tasks:brief' } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'QUOTA_EXCEEDED' } });
  });

  it('rejects bad action / negative limit', async () => {
    await expect(
      resolvers.Mutation.setQuotaLimit(
        {},
        { input: { orgRef: org.id, action: 'comm.outbound', limit: 5 } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      resolvers.Mutation.setQuotaLimit(
        {},
        { input: { orgRef: org.id, action: 'run.execute', limit: -1 } },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

// ───── policy authoring + debug ─────────────────────────────────────────────

describe('policy links + effectiveActionPolicy (#510, cor:acl:040:02)', () => {
  it('updateOrganization/updateApp store a valid link and reject a malformed one', async () => {
    await resolvers.Mutation.updateOrganization(
      {},
      { id: org.id, policy: { allow: ['run.execute', 'llm.invoke', 'memory.*'] } },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.updateApp({}, { id: app.id, policy: { allow: 'oops' } }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const orgRow = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(orgRow.policy).toEqual({ allow: ['run.execute', 'llm.invoke', 'memory.*'] });
  });

  it('explains per-layer verdicts and pinpoints the denying layer', async () => {
    await resolvers.Mutation.updateOrganization(
      {},
      { id: org.id, policy: { allow: ['*'] } },
      adminCtx(),
    );
    await resolvers.Mutation.updateApp(
      {},
      { id: app.id, policy: { allow: ['run.execute', 'memory.read'] } },
      adminCtx(),
    );
    const verdict = await resolvers.Query.effectiveActionPolicy(
      {},
      { appRef: app.id, action: 'comm.outbound' },
      adminCtx(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.layers).toEqual([
      { layer: 'org', present: true, allowed: true, allow: ['*'] },
      { layer: 'app', present: true, allowed: false, allow: ['run.execute', 'memory.read'] },
    ]);
  });

  it('includes the user layer when userRef is given; absent layers allow', async () => {
    await resolvers.Mutation.updateMyPolicy(
      {},
      { policy: { allow: ['memory.read'] } },
      adminCtx(),
    );
    const verdict = await resolvers.Query.effectiveActionPolicy(
      {},
      { appRef: app.id, action: 'memory.read', userRef: admin.id },
      adminCtx(),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.layers.map((l: { layer: string; present: boolean }) => [l.layer, l.present])).toEqual([
      ['org', false],
      ['user', true],
      ['app', false],
    ]);
  });

  it('updateMyPolicy requires auth, validates shape, and null clears', async () => {
    await expect(
      resolvers.Mutation.updateMyPolicy({}, { policy: { allow: ['*'] } }, { db, roles: [] } as never),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    await resolvers.Mutation.updateMyPolicy({}, { policy: { allow: ['*'] } }, adminCtx());
    await resolvers.Mutation.updateMyPolicy({}, { policy: null }, adminCtx());
    const user = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(user.policy).toBeNull();
  });
});

// ───── #501 — agent-memory grants ───────────────────────────────────────────

describe('agent-memory grants (#501)', () => {
  let agentId: string;
  let memoryId: string;

  beforeEach(async () => {
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: 'adm-org:agent', name: 'agent' },
    });
    agentId = agent.id;
    const memory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, name: 'm', urn: 'adm-org:m', class: 'knowledge',
      },
    });
    memoryId = memory.id;
  });

  it('addMemoryToAgent is an idempotent upsert (re-attach updates the role)', async () => {
    await resolvers.Mutation.addMemoryToAgent({}, { agentId, memoryId, role: 'read' }, adminCtx());
    await resolvers.Mutation.addMemoryToAgent(
      {},
      { agentId, memoryId, role: 'read-write' },
      adminCtx(),
    );
    const grant = await db.agentMemoryItem.findUniqueOrThrow({
      where: { agentId_memoryId: { agentId, memoryId } },
    });
    expect(grant.role).toBe('read-write');
    expect(grant.deletedAt).toBeNull();
  });

  it('resurrects a soft-deleted grant instead of failing on the unique slot', async () => {
    await db.agentMemoryItem.create({
      data: { agentId, memoryId, role: 'read', deletedAt: new Date(), deletedBy: 'someone' },
    });
    await resolvers.Mutation.addMemoryToAgent({}, { agentId, memoryId, role: 'read' }, adminCtx());
    const grant = await db.agentMemoryItem.findUniqueOrThrow({
      where: { agentId_memoryId: { agentId, memoryId } },
    });
    expect(grant.deletedAt).toBeNull();
    expect(grant.deletedBy).toBeNull();
  });

  it('updateAgentMemoryRole on a missing grant is a typed NOT_FOUND, not a raw P2025', async () => {
    await expect(
      resolvers.Mutation.updateAgentMemoryRole(
        {},
        { agentId, memoryId, role: 'read-write' },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('updateAgentMemoryRole refuses a soft-deleted grant (stays inactive; PR-512 review)', async () => {
    await db.agentMemoryItem.create({
      data: { agentId, memoryId, role: 'read', deletedAt: new Date() },
    });
    await expect(
      resolvers.Mutation.updateAgentMemoryRole(
        {},
        { agentId, memoryId, role: 'read-write' },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    const grant = await db.agentMemoryItem.findUniqueOrThrow({
      where: { agentId_memoryId: { agentId, memoryId } },
    });
    expect(grant.role).toBe('read'); // untouched — resurrection is addMemoryToAgent's job
    expect(grant.deletedAt).not.toBeNull();
  });
});
