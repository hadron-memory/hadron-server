/**
 * #3976 — updateApp on an uninstalled App (cor:dmo:050:21: "Uninstalled: the App is kept, read-only").
 * Every pin is red on main: updateApp has no install-state check anywhere in its path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as GraphQLError;
    return { code: err.extensions?.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string) =>
  db.user.create({ data: { githubId: 9_300_000 + ++n, githubUsername: `ua-${label}-${generateId()}`, roles: ['READER'] }, select: { id: true } });

let org: { id: string; urn: string };
let admin: { id: string }, member: { id: string }, stranger: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'ua-org', urn: `ua-${generateId().toLowerCase()}.example` } });
  [admin, member, stranger] = await Promise.all(['ad', 'me', 'st'].map(mkUser));
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' } });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Ua', urn: `${org.urn}:ua`, description: 'before' },
    select: { id: true, urn: true },
  });
});

const row = () => db.app.findUniqueOrThrow({ where: { id: app.id } });
const uninstall = () => M.uninstallApp({}, { ref: app.id }, ctx(admin.id));

/** One argument set per field updateApp can set (name, urn, ...), so no field is left unpinned. */
const FIELDS: Record<string, Record<string, unknown>> = {
  name: { name: 'Renamed' },
  urn: { urn: 'renamed-slug' },
  appType: { appType: 'CHATBOT' },
  role: { role: 'ADMIN' },
  description: { description: 'after' },
  agentTools: { agentTools: ['x'] },
  expiresAt: { expiresAt: '2030-01-01T00:00:00Z' },
  surfaces: { surfaces: ['web'] },
  trainingMode: { trainingMode: true },
  createUserPermission: { createUserPermission: 'DENY' },
  identifyUserMethod: { identifyUserMethod: 'SECRET' },
  sessionTimeoutSeconds: { sessionTimeoutSeconds: 1234 },
  sessionDormancyDays: { sessionDormancyDays: 9 },
  agentSessionsExpire: { agentSessionsExpire: true },
  anonymousTtlDays: { anonymousTtlDays: 7 },
  policy: { policy: { allow: ['x'] } },
  aiConfig: { aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5', aiApiKey: 'sk-test-key' },
};

describe('#3976 updateApp on an uninstalled App', () => {
  for (const [field, args] of Object.entries(FIELDS)) {
    it(`refuses ${field} with APP_UNINSTALLED and writes nothing`, async () => {
      await uninstall();
      const before = await row();
      const r = await refusal(M.updateApp({}, { ref: app.id, ...args }, ctx(admin.id)));
      expect(r.code).toBe('APP_UNINSTALLED');
      const after = await row();
      expect(after).toEqual(before);
      expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(0);
    });
  }

  it('a bare URN no longer resolves an uninstalled App (active-row resolution): refused, nothing written', async () => {
    await uninstall();
    await refusal(M.updateApp({}, { ref: app.urn, description: 'x' }, ctx(admin.id)));
    expect((await row()).description).toBe('before');
  });

  it('refuses AFTER the gate: a caller the gate refuses learns nothing about the install state', async () => {
    await uninstall();
    const installedOther = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Live', urn: `${org.urn}:live` } });
    const ghost = await refusal(M.updateApp({}, { ref: installedOther.id, description: 'x' }, ctx(stranger.id)));
    for (const who of [member.id, stranger.id]) {
      const r = await refusal(M.updateApp({}, { ref: app.id, description: 'x' }, ctx(who)));
      expect(r).toEqual(ghost);
      expect(r.code).not.toBe('APP_UNINSTALLED');
    }
  });

  for (const [field, args] of Object.entries(FIELDS)) {
    it(`control: the ${field} arguments are valid on an installed App`, async () => {
      await expect(M.updateApp({}, { ref: app.id, ...args }, ctx(admin.id))).resolves.toBeTruthy();
    });
  }

  it('refuses before judging the input: an invalid argument on an uninstalled App is APP_UNINSTALLED', async () => {
    await uninstall();
    const r = await refusal(M.updateApp({}, { ref: app.id, sessionTimeoutSeconds: 0 }, ctx(admin.id)));
    expect(r.code).toBe('APP_UNINSTALLED');
  });

  it('re-judges on the locked row: an uninstall landing after the first read still writes nothing (AI config included)', async () => {
    const live = await row();
    await uninstall();
    // The resolver's first read sees the App as still installed (the race); the locked re-read must refuse.
    const spy = vi.spyOn(db.app, 'findUniqueOrThrow').mockResolvedValueOnce(live as never);
    try {
      const r = await refusal(M.updateApp({}, { ref: app.id, description: 'raced', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5', aiApiKey: 'sk-test-key' }, ctx(admin.id)));
      expect(r.code).toBe('APP_UNINSTALLED');
    } finally {
      spy.mockRestore();
    }
    expect((await row()).description).toBe('before');
    expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(0);
  });

  it('control: an installed App still updates', async () => {
    const out = await M.updateApp({}, { ref: app.id, description: 'after' }, ctx(admin.id));
    expect(out.description).toBe('after');
  });

  it('control: after reinstallApp the App is writable again', async () => {
    await uninstall();
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    const out = await M.updateApp({}, { ref: app.id, description: 'after' }, ctx(admin.id));
    expect(out.description).toBe('after');
  });
});

/**
 * §10 finding on #3980 (Ralion, P2): the App-owned AI-config registry writes are App-management writes too.
 * create/update/delete with ownerType APP refuse on an uninstalled App, after the owner gate, in the write's transaction.
 */
describe('#3976 App-owned AI-config writes on an uninstalled App', () => {
  const base = { ownerType: 'APP', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test-key' };
  const mkConfig = async () => (await M.createAiServiceConfig({}, { ...base, ownerId: app.id, name: 'default' }, ctx(admin.id))).id as string;
  const cfg = (id: string) => db.aiServiceConfig.findUniqueOrThrow({ where: { id } });

  it('createAiServiceConfig refuses APP_UNINSTALLED and creates nothing', async () => {
    await uninstall();
    const r = await refusal(M.createAiServiceConfig({}, { ...base, ownerId: app.id, name: 'default' }, ctx(admin.id)));
    expect(r.code).toBe('APP_UNINSTALLED');
    expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(0);
  });

  it('updateAiServiceConfig refuses APP_UNINSTALLED and changes nothing', async () => {
    const id = await mkConfig();
    await uninstall();
    const r = await refusal(M.updateAiServiceConfig({}, { id, model: 'changed' }, ctx(admin.id)));
    expect(r.code).toBe('APP_UNINSTALLED');
    expect((await cfg(id)).model).toBe('claude-sonnet-5-5');
  });

  it('deleteAiServiceConfig refuses APP_UNINSTALLED and deletes nothing', async () => {
    const id = await mkConfig();
    await uninstall();
    const r = await refusal(M.deleteAiServiceConfig({}, { id }, ctx(admin.id)));
    expect(r.code).toBe('APP_UNINSTALLED');
    expect(await db.aiServiceConfig.count({ where: { id } })).toBe(1);
  });

  it('refuses before judging the input: an invalid argument on an uninstalled App is APP_UNINSTALLED', async () => {
    const id = await mkConfig();
    await uninstall();
    expect((await refusal(M.createAiServiceConfig({}, { ...base, ownerId: app.id, name: 'x', provider: 'no-such-provider' }, ctx(admin.id)))).code).toBe('APP_UNINSTALLED');
    expect((await refusal(M.updateAiServiceConfig({}, { id, provider: 'no-such-provider' }, ctx(admin.id)))).code).toBe('APP_UNINSTALLED');
  });

  it('refuses AFTER the gate: a caller the gate refuses does not learn the install state', async () => {
    const id = await mkConfig();
    await uninstall();
    for (const run of [
      () => M.createAiServiceConfig({}, { ...base, ownerId: app.id, name: 'x' }, ctx(stranger.id)),
      () => M.updateAiServiceConfig({}, { id, model: 'changed' }, ctx(stranger.id)),
      () => M.deleteAiServiceConfig({}, { id }, ctx(stranger.id)),
    ]) {
      expect((await refusal(run())).code).not.toBe('APP_UNINSTALLED');
    }
  });

  it('re-judges on the locked row: an uninstall landing after the early read still writes nothing', async () => {
    const id = await mkConfig();
    const live = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    await uninstall();
    for (const run of [
      () => M.createAiServiceConfig({}, { ...base, ownerId: app.id, name: 'raced' }, ctx(admin.id)),
      () => M.updateAiServiceConfig({}, { id, model: 'raced' }, ctx(admin.id)),
      () => M.deleteAiServiceConfig({}, { id }, ctx(admin.id)),
    ]) {
      // The early (unlocked) read sees the App as still installed; the locked re-read must refuse.
      const spy = vi.spyOn(db.app, 'findUnique').mockResolvedValueOnce(live as never);
      try {
        expect((await refusal(run())).code).toBe('APP_UNINSTALLED');
      } finally {
        spy.mockRestore();
      }
    }
    expect((await cfg(id)).model).toBe('claude-sonnet-5-5');
    expect(await db.aiServiceConfig.count({ where: { appId: app.id } })).toBe(1);
  });

  it('control: installed App, and after reinstallApp, the registry is writable', async () => {
    const id = await mkConfig();
    await uninstall();
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    expect((await M.updateAiServiceConfig({}, { id, model: 'after' }, ctx(admin.id))).model).toBe('after');
    expect(await M.deleteAiServiceConfig({}, { id }, ctx(admin.id))).toBe(true);
  });
});
