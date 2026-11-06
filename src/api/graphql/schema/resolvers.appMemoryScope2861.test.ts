/**
 * #2861 (cor:dmo:050:17, S6/S7) — a free-standing app memory (the row
 * `createAppMemory` makes: class app, appId set, no Agent link, not the team
 * space) is an APP_MEMORY source of the App's memory scope, for App
 * participants only. `appNodes` shares the scope, so its nodes follow.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

type Row = { memoryId: string; sources: Array<{ kind: string; agentId: string | null }> };

let n: number;
let org: { id: string; urn: string };
const user: Record<string, string> = {};
const app: Record<string, string> = {};
const agent: Record<string, string> = {};
const mem: Record<string, string> = {};

const ctx = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });

async function appMemory(
  key: string,
  appKey: string,
  extra: Record<string, unknown> = {},
  owner: { org?: boolean } = { org: true },
) {
  const urn = owner.org === false ? `u2861-${n}:${key.toLowerCase()}` : `${org.urn}:${key.toLowerCase()}`;
  mem[key] = (await db.memory.create({
    data: {
      class: 'app', organizationId: owner.org === false ? null : org.id,
      ownerUserId: owner.org === false ? user.owner! : null,
      name: key, urn, appId: app[appKey]!, visibility: null, ...extra,
    },
  })).id;
  await db.node.create({ data: { memoryId: mem[key]!, loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  return mem[key]!;
}

async function makeAgent(key: string) {
  const sys = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${key} system`, urn: `${org.urn}:${key}-system` } });
  mem[`sys${key}`] = sys.id;
  agent[key] = (await db.agent.create({
    data: { organizationId: org.id, name: key, urn: `${org.urn}:${key}`, visibility: 'ORGANIZATION', systemMemoryId: sys.id },
  })).id;
}

const scope = async (who: string, appKey = 'main'): Promise<Row[]> =>
  (await Q.appMemoryScope({}, { appRef: app[appKey], limit: 200 }, ctx(who))).items;
const keyOf = (id: string) => Object.entries(mem).find(([, v]) => v === id)?.[0] ?? id;
const scopeKeys = async (who: string, appKey = 'main') => (await scope(who, appKey)).map((r) => keyOf(r.memoryId)).sort();
const nodeMemoryKeys = async (who: string, appKey = 'main') =>
  [...new Set<string>((await Q.appNodes({}, { appRef: app[appKey] }, ctx(who))).map((x: { memoryId: string }) => keyOf(x.memoryId)))].sort();

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Fs', urn: `fs2861-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['participant', 'contributor', 'reader', 'stranger', 'owner', 'bothApps']) {
    user[who] = (await db.user.create({ data: { handle: `s2861-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.contributor!, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.bothApps!, role: 'READER' } });

  app.main = (await db.app.create({ data: { name: 'Main', urn: `${org.urn}:main`, organizationId: org.id } })).id;
  app.other = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: org.id } })).id;
  app.mine = (await db.app.create({ data: { name: 'Mine', urn: `u2861-${n}:mine`, ownerUserId: user.owner! } })).id;
  await db.appMember.create({ data: { appId: app.main, userId: user.participant!, role: 'member' } });
  await db.appMember.create({ data: { appId: app.main, userId: user.bothApps!, role: 'member' } });
  await db.appMember.create({ data: { appId: app.other, userId: user.bothApps!, role: 'member' } });

  await makeAgent('Alpha');
  await db.appAgent.create({ data: { appId: app.main, agentId: agent.Alpha! } });
  await db.node.create({ data: { memoryId: mem.sysAlpha!, loc: 'notes:alpha', name: 'Alpha', content: 'a' } });

  await appMemory('Tenant', 'main');
  await appMemory('OtherTenant', 'other');
  await appMemory('GoneTenant', 'main', { deletedAt: new Date() });
  await appMemory('TeamSpace', 'main', { sharedMemoryOfAgentId: agent.Alpha });
  // A name-addressable memory an Agent links is an AGENT_LINK, never a second source.
  await appMemory('Linked', 'main');
  await db.agentMemoryItem.create({ data: { agentId: agent.Alpha!, memoryId: mem.Linked! } });
  // A user-owned App with its own tenant memory (no Agent installed there).
  await appMemory('MineTenant', 'mine', {}, { org: false });
});

describe('#2861 — a free-standing app memory is listed for App participants (S6)', () => {
  for (const who of ['participant', 'contributor']) {
    it(`${who} sees it once, as APP_MEMORY, with its nodes`, async () => {
      const rows = await scope(who);
      const row = rows.find((r) => r.memoryId === mem.Tenant);
      expect(row?.sources).toEqual([{ kind: 'APP_MEMORY', agentId: null }]);
      expect(rows.filter((r) => r.memoryId === mem.Tenant)).toHaveLength(1);
      expect(await nodeMemoryKeys(who)).toContain('Tenant');
    });
  }

  it('the owner of a user-owned App sees its tenant memory and nodes', async () => {
    expect(await scopeKeys('owner', 'mine')).toEqual(['MineTenant']);
    expect(await nodeMemoryKeys('owner', 'mine')).toEqual(['MineTenant']);
  });

  it('a legacy (unkeyed, urn-identified) team space is TEAM_SPACE only, never also APP_MEMORY', async () => {
    await db.memory.update({ where: { id: mem.TeamSpace! }, data: { sharedMemoryOfAgentId: null, urn: `${org.urn}:main:alpha:shared` } });
    const rows = await scope('participant');
    expect(rows.find((r) => r.memoryId === mem.TeamSpace)?.sources).toEqual([{ kind: 'TEAM_SPACE', agentId: null }]);
  });

  it('an Agent-linked memory stays a single AGENT_LINK row, and the team space stays TEAM_SPACE', async () => {
    const rows = await scope('participant');
    expect(rows.find((r) => r.memoryId === mem.Linked)?.sources).toEqual([{ kind: 'AGENT_LINK', agentId: agent.Alpha }]);
    expect(rows.find((r) => r.memoryId === mem.TeamSpace)?.sources).toEqual([{ kind: 'TEAM_SPACE', agentId: null }]);
  });
});

describe('#2861 — everyone else gets nothing of it (S7)', () => {
  it('a non-participant org READER gets neither the row nor its nodes', async () => {
    expect(await scopeKeys('reader')).not.toContain('Tenant');
    expect(await nodeMemoryKeys('reader')).not.toContain('Tenant');
  });

  it('a stranger is refused exactly as the node read refuses', async () => {
    await expect(scope('stranger')).rejects.toThrow();
    await expect(Q.appNodes({}, { appRef: app.main }, ctx('stranger'))).rejects.toThrow();
  });

  it('another App\'s tenant memory is never admitted, even through the wrong appRef for a participant of both', async () => {
    expect(await scopeKeys('bothApps', 'main')).toEqual(expect.not.arrayContaining(['OtherTenant']));
    expect(await nodeMemoryKeys('bothApps', 'main')).not.toContain('OtherTenant');
    expect(await scopeKeys('bothApps', 'other')).toEqual(['OtherTenant']);
    expect(await scopeKeys('bothApps', 'main')).toContain('Tenant');
    expect(await scopeKeys('bothApps', 'other')).not.toContain('Tenant');
  });

  it('a soft-deleted tenant memory is not listed', async () => {
    expect(await scopeKeys('participant')).not.toContain('GoneTenant');
    expect(await nodeMemoryKeys('participant')).not.toContain('GoneTenant');
  });

  it('a soft-uninstalled App does not revive the participant arm', async () => {
    await db.app.update({ where: { id: app.main }, data: { uninstalledAt: new Date() } });
    await expect(scope('participant')).rejects.toThrow();
  });

  it('a Worker\'s working memory is not a free-standing app memory', async () => {
    const wm = await appMemory('WorkerMem', 'main');
    await db.worker.create({ data: { ...(await import('../../../lib/workerSignature.js')).WORKER_SIGNATURE_DEFAULTS, appId: app.main!, agentId: agent.Alpha!, name: 'Iris', slug: 'iris', memoryId: wm } });
    expect(await scopeKeys('participant')).not.toContain('WorkerMem');
  });

  it('a session memory (userMemoryOfAgentId) is not a free-standing app memory', async () => {
    await appMemory('SessionMem', 'main', { userMemoryOfAgentId: agent.Alpha });
    expect(await scopeKeys('participant')).not.toContain('SessionMem');
  });
});
