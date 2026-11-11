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
