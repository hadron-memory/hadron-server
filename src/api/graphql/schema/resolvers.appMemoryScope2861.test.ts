/**
 * #2861 (cor:dmo:050:17, S6/S7) — a free-standing app memory (the row
 * `createAppMemory` makes: appId set, class 'app', no Agent link, not the team
 * space) is in an App's scope for an App PARTICIPANT only, as source
 * APP_MEMORY, and appNodes reads its nodes for the same callers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
type Row = { memoryId: string; sources: Array<{ kind: string; agentId: string | null }>; viewerCanWrite: boolean };

let n: number;
let org: { id: string; urn: string };
const user: Record<string, string> = {};
const mem: Record<string, string> = {};
let appId: string;
let otherAppId: string;
let ownedAppId: string;
let agentId: string;

const ctx = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });

async function appMemory(key: string, data: { appId?: string; ownerUserId?: string; orgId?: string | null; deletedAt?: Date } = {}) {
  const orgId = data.orgId === undefined ? org.id : data.orgId;
  mem[key] = (await db.memory.create({
    data: {
      class: 'app', name: key, urn: `${orgId ? org.urn : `u${n}`}:${key.toLowerCase()}`,
      organizationId: orgId, ownerUserId: data.ownerUserId ?? null, appId: data.appId ?? appId,
      deletedAt: data.deletedAt ?? null,
    },
  })).id;
  await db.node.create({ data: { memoryId: mem[key], loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  return mem[key]!;
}

const scope = async (who: string, ref = appId) => (await Q.appMemoryScope({}, { appRef: ref, limit: 200 }, ctx(who))).items as Row[];
const nodeMemoryIds = async (who: string, ref = appId) =>
  new Set<string>((await Q.appNodes({}, { appRef: ref }, ctx(who))).map((x: { memoryId: string }) => x.memoryId));

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Scope', urn: `scope2861-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['reader', 'contributor', 'member', 'external', 'stranger', 'owner', 'both']) {
    user[who] = (await db.user.create({ data: { handle: `s2861-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.contributor!, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.member!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.both!, role: 'READER' } });

  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: org.id } })).id;
  ownedAppId = (await db.app.create({ data: { name: 'Mine', urn: `u${n}:mine`, ownerUserId: user.owner! } })).id;
  await db.appMember.create({ data: { appId, userId: user.member!, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: user.external!, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: user.both!, role: 'member' } });
  await db.appMember.create({ data: { appId: otherAppId, userId: user.both!, role: 'member' } });

  const sys = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'sys', urn: `${org.urn}:sys` } });
  agentId = (await db.agent.create({
    data: { organizationId: org.id, name: 'Alpha', urn: `${org.urn}:alpha`, visibility: 'ORGANIZATION', systemMemoryId: sys.id },
  })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appAgent.create({ data: { appId: ownedAppId, agentId } });

  await appMemory('Tenant');
  await appMemory('OtherTenant', { appId: otherAppId });
  await appMemory('OwnedTenant', { appId: ownedAppId, orgId: null, ownerUserId: user.owner! });
});

describe('#2861 — org App: who sees the free-standing app memory', () => {
  for (const who of ['contributor', 'member', 'external']) {
    it(`${who} (a participant): listed once as APP_MEMORY, and appNodes reads its nodes`, async () => {
      const rows = await scope(who);
      const row = rows.find((r) => r.memoryId === mem.Tenant);
      expect(row, 'Tenant missing from the participant scope').toBeDefined();
      expect(rows.filter((r) => r.memoryId === mem.Tenant)).toHaveLength(1);
      expect(row!.sources).toEqual([{ kind: 'APP_MEMORY', agentId: null }]);
      expect((await nodeMemoryIds(who)).has(mem.Tenant!)).toBe(true);
    });
  }

  it('a non-participant org READER gets neither the memory nor its nodes (S7)', async () => {
    expect((await scope('reader')).map((r) => r.memoryId)).not.toContain(mem.Tenant);
    expect((await nodeMemoryIds('reader')).has(mem.Tenant!)).toBe(false);
  });

  it('a stranger is refused exactly as appNodes refuses them (S7)', async () => {
    const refusal = await Q.appNodes({}, { appRef: appId }, ctx('stranger')).catch((e: Error) => e);
    expect(refusal).toBeInstanceOf(Error);
    await expect(Q.appMemoryScope({}, { appRef: appId }, ctx('stranger'))).rejects.toThrow(refusal.message);
  });

  it('another App\'s tenant memory is never admitted, even to a participant of both Apps through the wrong appRef', async () => {
    const rows = await scope('both');
    expect(rows.map((r) => r.memoryId)).toContain(mem.Tenant);
    expect(rows.map((r) => r.memoryId)).not.toContain(mem.OtherTenant);
    expect((await nodeMemoryIds('both')).has(mem.OtherTenant!)).toBe(false);
    expect((await scope('both', otherAppId)).map((r) => r.memoryId)).toEqual([mem.OtherTenant]);
  });

  it('a soft-deleted tenant memory is not listed', async () => {
    await db.memory.update({ where: { id: mem.Tenant! }, data: { deletedAt: new Date() } });
    expect((await scope('member')).map((r) => r.memoryId)).not.toContain(mem.Tenant);
    expect((await nodeMemoryIds('member')).has(mem.Tenant!)).toBe(false);
  });

  it('is not double-listed: the team space keeps TEAM_SPACE only, a linked app memory keeps its AGENT_LINK', async () => {
    await db.memory.create({ data: {
      class: 'app', name: 'Team', urn: `${org.urn}:team`, organizationId: org.id, appId, sharedMemoryOfAgentId: agentId,
    } });
    await appMemory('Linked');
    await db.agentMemoryItem.create({ data: { agentId, memoryId: mem.Linked! } });
    const rows = await scope('member');
    const kinds = (id: string) => rows.find((r) => r.memoryId === id)?.sources.map((s) => s.kind);
    expect(kinds(mem.Linked!)).toEqual(['AGENT_LINK']);
    const team = rows.find((r) => r.sources.some((s) => s.kind === 'TEAM_SPACE'))!;
    expect(team.sources.map((s) => s.kind)).toEqual(['TEAM_SPACE']);
  });

  it('a worker\'s working memory is not a free-standing app memory (it stays out for a participant, and Tenant is in)', async () => {
    await appMemory('WorkerMem');
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Iris', slug: 'iris', memoryId: mem.WorkerMem! } });
    const ids = (await scope('member')).map((r) => r.memoryId);
    expect(ids).toContain(mem.Tenant);
    expect(ids).not.toContain(mem.WorkerMem);
  });

  it('a participant of an uninstalled App keeps the TEAM_SPACE rule: an org-authorized reader still gets nothing extra', async () => {
    await db.app.update({ where: { id: appId }, data: { uninstalledAt: new Date() } });
    expect((await scope('reader')).map((r) => r.memoryId)).not.toContain(mem.Tenant);
  });
});

describe('#2861 — user-owned App', () => {
  it('the owner sees the tenant memory as APP_MEMORY and appNodes reads its nodes', async () => {
    const row = (await scope('owner', ownedAppId)).find((r) => r.memoryId === mem.OwnedTenant);
    expect(row, 'OwnedTenant missing from the owner scope').toBeDefined();
    expect(row!.sources).toEqual([{ kind: 'APP_MEMORY', agentId: null }]);
    expect((await nodeMemoryIds('owner', ownedAppId)).has(mem.OwnedTenant!)).toBe(true);
  });

  it('a stranger is refused, as appNodes refuses them', async () => {
    const refusal = await Q.appNodes({}, { appRef: ownedAppId }, ctx('stranger')).catch((e: Error) => e);
    expect(refusal).toBeInstanceOf(Error);
    await expect(Q.appMemoryScope({}, { appRef: ownedAppId }, ctx('stranger'))).rejects.toThrow(refusal.message);
  });
});
