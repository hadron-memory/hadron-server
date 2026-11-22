/**
 * #709 (gate issuecomment-7081773933; Victor's FIT 7081748038: hrn:node:hadronmemory.com:specs:cor:urn:030:01,
 * hrn:node:hadronmemory.com:specs:cor:urn:030:02, hrn:node:hadronmemory.com:specs:cor:api:010:02) — `mergeUsers` re-roots
 * the source's DEAD owned rows (soft-deleted memories and agents; soft-deleted and/or uninstalled Apps) onto the target
 * root, as it does the live ones: same `legacyUrn` and alias, same durable `entry_node_urn` rewrite. It MINTS AROUND
 * every holder, dead or live, and never reclaims, so a merge always completes and no row is deleted. Live rows go
 * first, so a live row is never re-minted around a dead one. An old `source:` reference reaches the re-rooted dead row
 * through the alias and it stays not found. A dead row whose re-root or alias write fails keeps its URN (the rename does
 * not happen) and the merge completes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
/** Fail the alias write for one chosen old URN, as a database refusal would. */
const failAliasFor = vi.hoisted(() => ({ urn: null as string | null, code: 'P2002' }));
vi.mock('../../../lib/urnAlias.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/urnAlias.js')>();
  return {
    ...real,
    recordUrnRename: async (dbArg: Parameters<typeof real.recordUrnRename>[0], params: Parameters<typeof real.recordUrnRename>[1]) => {
      if (failAliasFor.urn && params.oldUrn === failAliasFor.urn) {
        throw new Prisma.PrismaClientKnownRequestError('alias write refused (test)', { code: failAliasFor.code, clientVersion: 'test' });
      }
      return real.recordUrnRename(dbArg, params);
    },
  };
});

let source: { id: string };
let target: { id: string };
const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const S = 'merge-source', T = 'merge-target';

async function agentOf(owner: { id: string }, name: string) {
  return resolvers.Mutation.createAgent({}, { name }, ctxFor(owner.id));
}
const softDelete = {
  memory: (id: string) => db.memory.update({ where: { id }, data: { deletedAt: new Date() } }),
  agent: (id: string) => db.agent.update({ where: { id }, data: { deletedAt: new Date() } }),
};
async function app(owner: { id: string }, slug: string, state: { deleted?: boolean; uninstalled?: boolean } = {}) {
  return db.app.create({ data: {
    id: generateId(), ownerUserId: owner.id, name: slug, urn: `${owner === source ? S : T}:${slug}`,
    ...(state.deleted ? { deletedAt: new Date() } : {}), ...(state.uninstalled ? { uninstalledAt: new Date() } : {}),
  } });
}
const rowCounts = async () => ({ memories: await db.memory.count(), agents: await db.agent.count(), apps: await db.app.count() });
const aliases = (entityId: string) => db.urnAlias.findMany({ where: { entityId } });

beforeEach(async () => {
  failAliasFor.urn = null; failAliasFor.code = 'P2002';
  await cleanDb(db);
  source = await db.user.create({ data: { id: generateId(), handle: S, roles: ['READER'] } });
  target = await db.user.create({ data: { id: generateId(), handle: T, roles: ['READER'] } });
});

describe('#709 dead owned rows are re-rooted onto the target', () => {
  it('a dead agent and its dead system memory end at the target root, with legacyUrn and an alias each', async () => {
    const agent = await agentOf(source, 'Notes');
    await softDelete.agent(agent.id); await softDelete.memory(agent.systemMemoryId!);
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    const a = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(a).toMatchObject({ urn: `${T}:notes`, ownerUserId: target.id, legacyUrn: `${S}:notes` });
    expect(a.deletedAt).not.toBeNull();
    const m = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    expect(m).toMatchObject({ urn: `${T}:notes-system`, ownerUserId: target.id, legacyUrn: `${S}:notes-system` });
    expect((await aliases(agent.id)).map((x) => [x.urn, x.replacedByUrn])).toEqual([[`${S}:notes`, `${T}:notes`]]);
    expect((await aliases(agent.systemMemoryId!)).map((x) => [x.urn, x.replacedByUrn])).toEqual([[`${S}:notes-system`, `${T}:notes-system`]]);
  });

  it.each([
    ['soft-deleted (still installed)', { deleted: true }],
    ['uninstalled', { uninstalled: true }],
    ['soft-deleted and uninstalled', { deleted: true, uninstalled: true }],
  ])('a %s App ends at the target root with legacyUrn and an alias', async (_label, state) => {
    const a = await app(source, 'team', state);
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await db.app.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ urn: `${T}:team`, ownerUserId: target.id, legacyUrn: `${S}:team` });
    expect((await aliases(a.id)).map((x) => [x.urn, x.replacedByUrn])).toEqual([[`${S}:team`, `${T}:team`]]);
  });

  it('no source-rooted row is owned by the target after the merge', async () => {
    const agent = await agentOf(source, 'Notes'); await softDelete.agent(agent.id); await softDelete.memory(agent.systemMemoryId!);
    const live = await agentOf(source, 'Live');
    await app(source, 'gone', { deleted: true }); await app(source, 'off', { uninstalled: true });
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    const rooted = (rows: Array<{ urn: string }>) => rows.filter((r) => r.urn.startsWith(`${S}:`)).map((r) => r.urn);
    expect(rooted(await db.memory.findMany({ where: { ownerUserId: target.id }, select: { urn: true } }))).toEqual([]);
    expect(rooted(await db.agent.findMany({ where: { ownerUserId: target.id }, select: { urn: true } }))).toEqual([]);
    expect(rooted(await db.app.findMany({ where: { ownerUserId: target.id }, select: { urn: true } }))).toEqual([]);
    expect((await db.agent.findUniqueOrThrow({ where: { id: live.id } })).urn).toBe(`${T}:live`);
  });
});

describe('#709 collisions: mint around every holder, never reclaim, the merge completes', () => {
  it('dead vs LIVE: the target\'s live holder keeps its URN; the dead source row is re-minted; no row is deleted', async () => {
    const mine = await agentOf(target, 'Notes');
    const dead = await agentOf(source, 'Notes'); await softDelete.agent(dead.id); await softDelete.memory(dead.systemMemoryId!);
    const before = await rowCounts();
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await rowCounts()).toEqual(before);
    expect((await db.agent.findUniqueOrThrow({ where: { id: mine.id } })).urn).toBe(`${T}:notes`);
    expect((await db.agent.findUniqueOrThrow({ where: { id: dead.id } })).urn).toBe(`${T}:notes-${S}`);
    expect((await db.memory.findUniqueOrThrow({ where: { id: dead.systemMemoryId! } })).urn).toBe(`${T}:notes-system-${S}`);
  });

  it('dead vs DEAD: the target\'s own tombstone is never reclaimed; the dead source row is re-minted around it', async () => {
    const tomb = await agentOf(target, 'Notes'); await softDelete.agent(tomb.id); await softDelete.memory(tomb.systemMemoryId!);
    const dead = await agentOf(source, 'Notes'); await softDelete.agent(dead.id); await softDelete.memory(dead.systemMemoryId!);
    const before = await rowCounts();
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await rowCounts()).toEqual(before);
    expect((await db.agent.findUniqueOrThrow({ where: { id: tomb.id } })).urn).toBe(`${T}:notes`);
    expect((await db.memory.findUniqueOrThrow({ where: { id: tomb.systemMemoryId! } })).urn).toBe(`${T}:notes-system`);
    expect((await db.agent.findUniqueOrThrow({ where: { id: dead.id } })).urn).toBe(`${T}:notes-${S}`);
    // The dead memory is minted around the target's DEAD memory too (re-rooted, not left behind by a refused write).
    expect((await db.memory.findUniqueOrThrow({ where: { id: dead.systemMemoryId! } })).urn).toBe(`${T}:notes-system-${S}`);
  });

  it('dead App vs an uninstalled target App: minted around it too, so no two Apps share a URN', async () => {
    const off = await app(target, 'team', { uninstalled: true });
    const gone = await app(source, 'team', { deleted: true });
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect((await db.app.findUniqueOrThrow({ where: { id: off.id } })).urn).toBe(`${T}:team`);
    expect((await db.app.findUniqueOrThrow({ where: { id: gone.id } })).urn).toBe(`${T}:team-${S}`);
  });

  it('live rows go first: a live source row takes its re-mint before a dead source row can', async () => {
    await agentOf(target, 'Notes');
    const liveSrc = await agentOf(source, 'Notes');
    // A dead source agent already holding the slug the live one will be re-minted to.
    const dead = await agentOf(source, `Notes ${S}`); await softDelete.agent(dead.id);
    expect(dead.urn).toBe(`${S}:notes-${S}`);
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect((await db.agent.findUniqueOrThrow({ where: { id: liveSrc.id } })).urn).toBe(`${T}:notes-${S}`);
    expect((await db.agent.findUniqueOrThrow({ where: { id: dead.id } })).urn).not.toBe(`${T}:notes-${S}`);
    expect((await db.agent.findUniqueOrThrow({ where: { id: dead.id } })).urn.startsWith(`${T}:`)).toBe(true);
  });
});

describe('#709 aliases, install memories, durable refs and a failed alias', () => {
  it('an old source reference reaches the re-rooted dead row through the alias, and it stays not found', async () => {
    const agent = await agentOf(source, 'Notes'); await softDelete.agent(agent.id);
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    // The alias exists and names the re-rooted dead row (Jimmy F4: observable, not just a rejection)…
    expect(await db.urnAlias.findMany({ where: { urn: `${S}:notes`, entityType: 'AGENT' }, select: { entityId: true, replacedByUrn: true } }))
      .toEqual([{ entityId: agent.id, replacedByUrn: `${T}:notes` }]);
    // …and the row it leads to stays dead: not found by the old reference or by the new one.
    await expect(resolveAgentRef(db, `hrn:agent:${S}:notes`)).rejects.toThrow();
    await expect(resolveAgentRef(db, `hrn:agent:${T}:notes`)).rejects.toThrow();
  });

  it('a dead agent with an install memory is re-rooted; the install memory still pairs with it by id', async () => {
    const agent = await agentOf(source, 'Helper');
    const a = await app(source, 'team');
    const install = await db.memory.create({ data: {
      id: generateId(), ownerUserId: source.id, urn: `${S}:team-install`, name: 'Install', class: 'system',
      appId: a.id, installOfAgentId: agent.id, isInstallMemory: true,
    } });
    await softDelete.agent(agent.id);
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).urn).toBe(`${T}:helper`);
    expect(await db.memory.findFirst({ where: { appId: a.id, installOfAgentId: agent.id } })).toMatchObject({ id: install.id, urn: `${T}:team-install` });
  });

  it('a durable entry_node_urn into a re-rooted dead memory is rewritten, as for a live one', async () => {
    const agent = await agentOf(source, 'Notes'); await softDelete.memory(agent.systemMemoryId!);
    const org = await db.organization.create({ data: { name: 'Sched', urn: `sched-${generateId()}.test` } });
    const a = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Sched', urn: `${org.urn}:sched` } });
    const sched = await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: org.id, appId: a.id, name: 'nightly', runAt: new Date(Date.now() + 3_600_000),
      entryNodeUrn: `hrn:node:${S}:notes-system:flows:start`,
    } });
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: sched.id } })).entryNodeUrn).toBe(`hrn:node:${T}:notes-system:flows:start`);
  });

  it('a refused dead MEMORY keeps its URN, and a durable ref into it stays consistent with it (not rewritten)', async () => {
    const agent = await agentOf(source, 'Notes'); await softDelete.memory(agent.systemMemoryId!);
    const org = await db.organization.create({ data: { name: 'Sched', urn: `sched-${generateId()}.test` } });
    const a = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Sched', urn: `${org.urn}:sched` } });
    const sched = await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: org.id, appId: a.id, name: 'nightly', runAt: new Date(Date.now() + 3_600_000),
      entryNodeUrn: `hrn:node:${S}:notes-system:flows:start`,
    } });
    failAliasFor.urn = `${S}:notes-system`;
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } })).toMatchObject({ urn: `${S}:notes-system`, legacyUrn: null, ownerUserId: target.id });
    expect((await db.agentSchedule.findUniqueOrThrow({ where: { id: sched.id } })).entryNodeUrn).toBe(`hrn:node:${S}:notes-system:flows:start`);
  });

  it('a refused dead APP keeps its URN and still moves owner', async () => {
    const gone = await app(source, 'team', { deleted: true });
    failAliasFor.urn = `${S}:team`;
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await db.app.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({ urn: `${S}:team`, legacyUrn: null, ownerUserId: target.id });
  });

  it.each([
    ['a serialization failure (the caller retries)', 'P2034'],
    ['a foreign-key violation (a bug, not a refusal)', 'P2003'],
    ['a missing row (a bug, not a refusal)', 'P2025'],
  ])('%s during a dead re-root aborts the whole merge, with nothing moved', async (_label, code) => {
    const agent = await agentOf(source, 'Notes'); await softDelete.agent(agent.id);
    failAliasFor.urn = `${S}:notes`; failAliasFor.code = code;
    await expect(mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id })).rejects.toThrow();
    expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({ urn: `${S}:notes`, ownerUserId: source.id });
    expect((await db.user.findUniqueOrThrow({ where: { id: source.id } })).deletedAt).toBeNull();
  });

  it('a dead row whose alias write fails keeps its URN (no rename without its alias); the rest of the merge completes', async () => {
    const stuck = await agentOf(source, 'Stuck'); await softDelete.agent(stuck.id);
    const fine = await agentOf(source, 'Fine'); await softDelete.agent(fine.id);
    failAliasFor.urn = `${S}:stuck`;
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await db.agent.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ urn: `${S}:stuck`, ownerUserId: target.id, legacyUrn: null });
    expect(await aliases(stuck.id)).toEqual([]);
    expect((await db.agent.findUniqueOrThrow({ where: { id: fine.id } })).urn).toBe(`${T}:fine`);
    expect((await db.user.findUniqueOrThrow({ where: { id: source.id } })).deletedAt).not.toBeNull();
  });
});
