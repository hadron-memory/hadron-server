/** hadron-internal#84 — `mergeNodes` and `clearNodeHistory` node references (cor:api:140:03). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const userCtx = (userId: string): Context => ({ db, userId, roles: [], clientId: `user:${userId}` });

beforeEach(async () => { await cleanDb(db); });

async function fixture() {
  const mkOrg = async (slug: string) =>
    db.organization.create({ data: { name: slug, urn: `${slug}-${generateId().toLowerCase()}` } });
  const org = await mkOrg('held');
  const otherOrg = await mkOrg('other');
  const mkUser = async (name: string, organizationId?: string, role?: 'ADMIN' | 'READER') => {
    const user = await db.user.create({ data: { name } });
    if (organizationId) await db.orgMember.create({ data: { organizationId, userId: user.id, role: role! } });
    return user;
  };
  const writer = await mkUser('writer', org.id, 'ADMIN');
  const reader = await mkUser('reader', org.id, 'READER');
  const stranger = await mkUser('stranger');
  const neighbour = await mkUser('neighbour', otherOrg.id, 'ADMIN');
  const { app } = await createDbAppWithKey(db, 'neighbour-app', otherOrg.id);

  const mkMemory = async (organization: { id: string; urn: string }, slug: string) =>
    db.memory.create({ data: { name: slug, urn: `${organization.urn}:${slug}`, class: 'knowledge', organizationId: organization.id } });
  const held = await mkMemory(org, 'held-memory');
  const own = await mkMemory(otherOrg, 'own-memory');
  const mkNode = async (memory: { id: string; urn: string }, by: string, loc: string, extra: object = {}) => {
    const node = await M.createNode({}, { input: { memoryRef: memory.id, loc, name: loc, content: `${loc} content` } }, userCtx(by));
    if (Object.keys(extra).length) await db.node.update({ where: { id: node.id }, data: extra });
    await M.updateNode({}, { input: { ref: node.id, content: `${loc} content, again` } }, userCtx(by));
    return { id: node.id as string, urn: `hrn:node:${memory.urn}:${loc}` };
  };
  const first = await mkNode(held, writer.id, 'first');
  const second = await mkNode(held, writer.id, 'second');
  const mine = await mkNode(own, neighbour.id, 'mine');
  const missing = (n = 'gone') => ({ id: generateId(), urn: `hrn:node:${held.urn}:${n}` });
  return { org, otherOrg, writer, reader, stranger, neighbour, app, held, own, first, second, mine, missing, mkNode };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function snapshot() {
  return {
    nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
    edges: await db.edge.findMany({ orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }),
  };
}

/** The whole answer a client can see from a refusal. */
async function answer(call: Promise<unknown>) {
  const error: any = await call.then(
    () => { throw new Error('expected a refusal'); },
    (e) => e,
  );
  return { message: error.message, extensions: { ...error.extensions } };
}

const sourceMissing = { message: 'Source node not found', extensions: { code: 'NODE_NOT_FOUND' } };
const targetMissing = { message: 'Target node not found', extensions: { code: 'NODE_NOT_FOUND' } };
const nodeMissing = { message: 'Node not found', extensions: { code: 'NODE_NOT_FOUND' } };

const merge = (ctx: Context, source: string, target: string, extra: object = {}) =>
  M.mergeNodes({}, { input: { source, target, ...extra } }, ctx);
const clear = (ctx: Context, nodeRef: string) => M.clearNodeHistory({}, { nodeRef }, ctx);

const outsiders: Array<[string, (f: F) => Context]> = [
  ['a user in no organization', (f) => userCtx(f.stranger.id)],
  ['another organization\'s admin', (f) => userCtx(f.neighbour.id)],
  ['another organization\'s App key', (f) => ({ db, appId: f.app.id, roles: [], clientId: `app:${f.app.id}` })],
];
const spellings = ['id', 'urn'] as const;
const modes: Array<[string, object]> = [
  ['all fields', {}],
  ['content only', { include: ['CONTENT'] }],
  ['source deleted', { include: ['CONTENT'], deleteSource: true }],
];

describe.each(outsiders)('as %s', (_label, who) => {
  describe.each(spellings)('by %s', (by) => {
    it.each(modes)('mergeNodes (%s): pairs of references', async (_m, extra) => {
      const f = await fixture();
      const before = await snapshot();
      expect(await answer(merge(who(f), f.missing('a')[by], f.missing('b')[by], extra))).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.first[by], f.second[by], extra))).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.first[by], f.missing()[by], extra))).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.missing()[by], f.second[by], extra))).toEqual(sourceMissing);
      expect(await snapshot()).toEqual(before);
    });

    it('mergeNodes: the same node on both sides', async () => {
      const f = await fixture();
      const gone = f.missing()[by];
      expect(await answer(merge(who(f), gone, gone))).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.first[by], f.first[by]))).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.first.id, f.first.urn))).toEqual(sourceMissing);
    });

    it('mergeNodes: a malformed target', async () => {
      const f = await fixture();
      const missing = await answer(merge(who(f), f.missing()[by], 'not:qualified'));
      expect(missing).toEqual(sourceMissing);
      expect(await answer(merge(who(f), f.first[by], 'not:qualified'))).toEqual(missing);
    });

    it('clearNodeHistory: unknown, live and deleted nodes', async () => {
      const f = await fixture();
      await db.node.update({ where: { id: f.second.id }, data: { deletedAt: new Date() } });
      const before = await snapshot();
      expect(await answer(clear(who(f), f.missing()[by]))).toEqual(nodeMissing);
      expect(await answer(clear(who(f), f.first[by]))).toEqual(nodeMissing);
      expect(await answer(clear(who(f), f.second.id))).toEqual(nodeMissing);
      expect(await snapshot()).toEqual(before);
    });
  });
});

/** A caller with a memory of their own and no rights in the other one. */
describe.each(spellings)('one reference in the caller\'s own memory, by %s', (by) => {
  it.each(modes)('mergeNodes (%s): own source, other target', async (_m, extra) => {
    const f = await fixture();
    const ctx = userCtx(f.neighbour.id);
    const before = await snapshot();
    expect(await answer(merge(ctx, f.mine[by], f.missing()[by], extra))).toEqual(targetMissing);
    expect(await answer(merge(ctx, f.mine[by], f.first[by], extra))).toEqual(targetMissing);
    expect(await snapshot()).toEqual(before);
  });

  it.each(modes)('mergeNodes (%s): other source, own target', async (_m, extra) => {
    const f = await fixture();
    const ctx = userCtx(f.neighbour.id);
    const before = await snapshot();
    expect(await answer(merge(ctx, f.missing()[by], f.mine[by], extra))).toEqual(sourceMissing);
    expect(await answer(merge(ctx, f.first[by], f.mine[by], extra))).toEqual(sourceMissing);
    expect(await snapshot()).toEqual(before);
  });

  it('mergeNodes: other compiled boot prompt source', async () => {
    const f = await fixture();
    const special = await f.mkNode(f.held, f.writer.id, 'special');
    await db.node.update({ where: { id: special.id }, data: { nodeType: 'system', role: 'prompt.boot.compiled' } });
    expect(await answer(merge(userCtx(f.neighbour.id), special[by], f.mine[by]))).toEqual(sourceMissing);
  });
});

describe('readers and writers of the memory', () => {
  it.each(spellings)('a reader is refused FORBIDDEN on both doors, by %s', async (by) => {
    const f = await fixture();
    const ctx = userCtx(f.reader.id);
    const before = await snapshot();
    for (const call of [
      () => merge(ctx, f.first[by], f.second[by]),
      () => clear(ctx, f.first[by]),
    ]) {
      expect((await answer(call())).message).toMatch(/Forbidden/);
    }
    // A reader may fold fields in only with write access to the target.
    expect((await answer(merge(userCtx(f.reader.id), f.first[by], f.second[by], { include: ['CONTENT'] }))).message).toMatch(/Forbidden/);
    expect(await snapshot()).toEqual(before);
  });

  it('a reader still hears that source and target are the same node', async () => {
    const f = await fixture();
    expect((await answer(merge(userCtx(f.reader.id), f.first.id, f.first.id))).extensions.code).toBe('MERGE_SOURCE_EQUALS_TARGET');
  });

  it('a writer merges and clears as before', async () => {
    const f = await fixture();
    const ctx = userCtx(f.writer.id);
    expect(await clear(ctx, f.first.urn)).toBeGreaterThan(0);
    await merge(ctx, f.first.id, f.second.id, { include: ['CONTENT'] });
    expect((await db.node.findUniqueOrThrow({ where: { id: f.second.id } })).content).toContain('first content');
  });

  it('a read-only source is still merged from', async () => {
    const f = await fixture();
    await db.orgMember.create({ data: { organizationId: f.org.id, userId: f.neighbour.id, role: 'READER' } });
    await merge(userCtx(f.neighbour.id), f.first.id, f.mine.id, { include: ['CONTENT'] });
    expect((await db.node.findUniqueOrThrow({ where: { id: f.mine.id } })).content).toContain('first content');
  });
});

describe('a source in an Agent system memory the caller does not read (#2206)', () => {
  it('answers as an unknown source', async () => {
    const f = await fixture();
    const platform = await db.user.create({ data: { name: 'platform', roles: ['ADMIN'] } });
    const agentOwner = await db.user.create({ data: { name: 'agent owner' } });
    const agent = await M.createAgent({}, { name: 'Personal Agent' }, userCtx(agentOwner.id));
    const node = await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId, loc: 'brain', name: 'brain', content: 'brain' } });
    const ctx: Context = { ...userCtx(platform.id), roles: ['ADMIN'] };
    for (const extra of [{ include: ['CONTENT'] }, {}]) {
      expect(await answer(merge(ctx, node.id, f.missing().id, extra))).toEqual(sourceMissing);
      expect(await answer(merge(ctx, node.id, node.id, extra))).toEqual(sourceMissing);
      expect(await answer(merge(ctx, node.id, f.first.id, extra))).toEqual(sourceMissing);
    }
  });
});
