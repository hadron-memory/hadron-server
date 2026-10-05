/** Defensive parity and rejection checks for stored on-behalf-of identities (#1643, DT). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { appRunMutations as M } from './resolvers.appRun.js';
import { canReadMemoryRecord, requireMemoryWriteAccess, type Context } from './resolvers.helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let orgId: string;
let appId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let platformId: string;
const ENTRY = 'hrn:node:run-identity:knowledge:tasks:entry';
const ctx = (userId: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

beforeEach(async () => {
  await cleanDb(db);
  const ids = await Promise.all(['owner', 'admin', 'member', 'platform'].map((name, i) => db.user.create({
    data: { id: generateId(), githubId: 1643000 + i, githubUsername: `identity-${name}`, roles: name === 'platform' ? ['ADMIN'] : ['READER'] },
  })));
  [ownerId, adminId, memberId, platformId] = ids.map(u => u.id);
  const org = await db.organization.create({ data: { id: generateId(), urn: 'run-identity', name: 'Run identity' } });
  orgId = org.id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: ownerId, role: 'ADMIN' },
    { organizationId: orgId, userId: adminId, role: 'ADMIN' },
    { organizationId: orgId, userId: memberId, role: 'READER' },
  ] });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, urn: 'hrn:app:run-identity:app', name: 'App' } });
  appId = app.id;
  await db.appMember.createMany({ data: [ownerId, adminId, memberId].map(userId => ({ appId, userId, role: 'member' })) });
});

const schedule = (userId: string | null = ownerId) => db.agentSchedule.create({ data: {
  id: generateId(), organizationId: orgId, appId, userId, name: 'Owner schedule', cron: '0 9 * * *',
  timezone: 'UTC', entryNodeUrn: ENTRY, eventData: { approved: 'owner' }, nextRunAt: new Date(Date.now() + 3600000),
} });
const webhook = (userId: string | null = ownerId) => db.agentWebhook.create({ data: {
  id: generateId(), organizationId: orgId, appId, userId, name: 'owner-hook', secret: 'original-secret', entryNodeUrn: ENTRY,
} });

const principals = () => [
  ['strict owner', ctx(ownerId), true],
  ['org admin', ctx(adminId), false],
  ['App member/reader', ctx(memberId), false],
  ['platform admin', ctx(platformId, ['ADMIN']), false],
  ['App key', { db, appId, roles: [] } as Context, false],
  ['anonymous', { db, roles: [] } as Context, false],
  ['impersonated owner', { ...ctx(ownerId), impersonation: { sessionId: generateId(), actorUserId: adminId, orgId, expiresAt: new Date(Date.now() + 60000) } }, false],
] as const;

describe('#1643 shared strict-owner parity', () => {
  it('matches personal/private record and write gates across owner, admin, member, App-key and impersonated principals', async () => {
    for (const memoryClass of ['personal', 'private'] as const) {
      const memory = await db.memory.create({ data: {
        id: generateId(), organizationId: orgId, userId: ownerId, class: memoryClass,
        urn: `run-identity:${memoryClass}`, name: memoryClass,
      } });
      for (const [label, principal, allowed] of principals()) {
        expect(isStrictOwner(principal, memory.userId), label).toBe(allowed);
        expect(await canReadMemoryRecord(principal, memory), `${memoryClass}: ${label}`).toBe(allowed);
        if (allowed) await expect(requireMemoryWriteAccess(principal, memory.id)).resolves.toBeUndefined();
        else await expect(requireMemoryWriteAccess(principal, memory.id)).rejects.toBeDefined();
      }
    }
  });

  it('fails closed for missing or empty owner identities; tenant ownership is a different axis', () => {
    for (const value of [null, undefined, '']) expect(isStrictOwner({ userId: ownerId }, value)).toBe(false);
    expect(isStrictOwner({ userId: '' }, '')).toBe(false);
    expect(isStrictOwner({}, ownerId)).toBe(false);
    expect(isStrictOwner({ userId: adminId }, ownerId)).toBe(false);
  });
});

describe('#1643 schedule edits', () => {
  it('refuses non-owner admin edits for omitted, null, cleared and replaced run-as identity, leaving the entire row unchanged', async () => {
    const row = await schedule();
    for (const actor of [ctx(adminId), ctx(platformId, ['ADMIN'])]) {
      for (const runAsSelf of [undefined, null, false, true]) {
        await expect(M.updateAgentSchedule({}, { id: row.id, input: { eventData: { edited: true }, runAsSelf } }, actor))
          .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
        expect(await db.agentSchedule.findUnique({ where: { id: row.id } })).toEqual(row);
      }
    }
  });

  it('retains the owner identity on owner edits and supports the owner explicitly removing it', async () => {
    const row = await schedule();
    const edited = await M.updateAgentSchedule({}, { id: row.id, input: { name: 'Owner edit', eventData: { approved: 'new' } } }, ctx(ownerId));
    expect(edited.userId).toBe(ownerId);
    expect(edited.eventData).toEqual({ approved: 'new' });
    const cleared = await M.updateAgentSchedule({}, { id: row.id, input: { runAsSelf: false } }, ctx(ownerId));
    expect(cleared.userId).toBeNull();
  });

  it('keeps no-user schedules administrable; selecting run-as-self uses only the editor identity', async () => {
    const row = await schedule(null);
    const edited = await M.updateAgentSchedule({}, { id: row.id, input: { name: 'Admin edit' } }, ctx(adminId));
    expect(edited.userId).toBeNull();
    const selected = await M.updateAgentSchedule({}, { id: row.id, input: { runAsSelf: true } }, ctx(adminId));
    expect(selected.userId).toBe(adminId);
  });

  it('refuses an owner whose current App relationship was revoked', async () => {
    const row = await schedule();
    await db.appMember.deleteMany({ where: { appId, userId: ownerId } });
    await expect(M.updateAgentSchedule({}, { id: row.id, input: { name: 'No relationship' } }, ctx(ownerId)))
      .rejects.toMatchObject({ extensions: { code: 'RELATIONSHIP_MISSING' } });
    expect(await db.agentSchedule.findUnique({ where: { id: row.id } })).toEqual(row);
  });

  it('requires the existing management gate in addition to being the stored identity owner', async () => {
    const row = await schedule(memberId);
    await expect(M.updateAgentSchedule({}, { id: row.id, input: { name: 'Member edit' } }, ctx(memberId)))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.agentSchedule.findUnique({ where: { id: row.id } })).toEqual(row);
  });

  it('rechecks the current stored identity after a trigger-row lock wait', async () => {
    const row = await schedule();
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { locked = r; });
    const holder = db.$transaction(async tx => {
      await tx.agentSchedule.update({ where: { id: row.id }, data: { userId: adminId } });
      locked(); await gate;
    }, { timeout: 20000 });
    await ready;
    const edit = M.updateAgentSchedule({}, { id: row.id, input: { name: 'Must not commit' } }, ctx(ownerId))
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await waitForLockWaitersOfType(db, 'transactionid');
      release(); await holder;
      expect((await edit).error).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      const current = await db.agentSchedule.findUniqueOrThrow({ where: { id: row.id } });
      expect(current.userId).toBe(adminId); expect(current.name).toBe(row.name);
    } finally { release(); await Promise.allSettled([holder, edit]); }
  });
});

describe('#1643 webhook credential rotation counterpart', () => {
  it('refuses a different org or platform admin without rotating the secret or returning credentials', async () => {
    const row = await webhook();
    for (const actor of [ctx(adminId), ctx(platformId, ['ADMIN'])]) {
      await expect(M.rotateAgentWebhook({}, { id: row.id }, actor)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(await db.agentWebhook.findUnique({ where: { id: row.id } })).toEqual(row);
    }
  });

  it('rechecks webhook ownership after its row lock wait', async () => {
    const row = await webhook();
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { locked = r; });
    const holder = db.$transaction(async tx => {
      await tx.agentWebhook.update({ where: { id: row.id }, data: { userId: adminId } });
      locked(); await gate;
    }, { timeout: 20000 });
    await ready;
    const rotate = M.rotateAgentWebhook({}, { id: row.id }, ctx(ownerId))
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await waitForLockWaitersOfType(db, 'transactionid');
      release(); await holder;
      expect((await rotate).error).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      const current = await db.agentWebhook.findUniqueOrThrow({ where: { id: row.id } });
      expect(current.userId).toBe(adminId); expect(current.secret).toBe(row.secret);
    } finally { release(); await Promise.allSettled([holder, rotate]); }
  });

  it('allows the stored owner to rotate while retaining that identity', async () => {
    const row = await webhook();
    const result = await M.rotateAgentWebhook({}, { id: row.id }, ctx(ownerId));
    expect(result.webhook.userId).toBe(ownerId);
    expect(result.webhook.secret).not.toBe(row.secret);
    expect(result.token).toBeTruthy();
  });

  it('keeps no-user webhooks administrable', async () => {
    const row = await webhook(null);
    const result = await M.rotateAgentWebhook({}, { id: row.id }, ctx(adminId));
    expect(result.webhook.userId).toBeNull();
    expect(result.webhook.secret).not.toBe(row.secret);
  });

  it('refuses rotation when the owner has lost the App relationship', async () => {
    const row = await webhook();
    await db.appMember.deleteMany({ where: { appId, userId: ownerId } });
    await expect(M.rotateAgentWebhook({}, { id: row.id }, ctx(ownerId)))
      .rejects.toMatchObject({ extensions: { code: 'RELATIONSHIP_MISSING' } });
    expect(await db.agentWebhook.findUnique({ where: { id: row.id } })).toEqual(row);
  });
});
