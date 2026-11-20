/**
 * #1291 — an atomic `exports` merge through the governed task door.
 *
 * `updateTaskNode(input, mergeExports: true)` treats `input.properties` as a PATCH merged by `mergePropertiesPatch`
 * (the function `updateNodeProperties` uses) under the node's advisory lock, on the row read after the lock. With the
 * option off the door replaces the whole bag, as before. The option lives on the task door's own argument, never on
 * the shared `UpdateNodeInput`, so no other door gains a merge mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
let adminId: string;
let outsiderId: string;
let memId: string;
let taskId: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const outsider = (): Context => ({ db, roles: ['READER'], userId: outsiderId } as Context);
const props = async () => (await db.node.findUniqueOrThrow({ where: { id: taskId } })).properties as Record<string, any>;
const merge = (properties: unknown, extra: Record<string, unknown> = {}, ctx: Context = admin()) =>
  M.updateTaskNode({}, { input: { id: taskId, properties, ...extra }, mergeExports: true }, ctx);
const claude = { name: 'one', description: 'Use when testing one.', enable: true };
const codex = { name: 'two', description: 'Use when testing two.', enable: true };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'tm-org', urn: 'tm-org' } });
  const a = await db.user.create({ data: { githubId: 129101, githubUsername: 'tm-admin', roles: ['ADMIN'] } });
  const o = await db.user.create({ data: { githubId: 129102, githubUsername: 'tm-out', roles: ['READER'] } });
  adminId = a.id;
  outsiderId = o.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  memId = (await M.createMemory({}, { orgRef: org.id, name: 'tasks' }, admin())).id;
  taskId = (
    await M.createTaskNode({}, {
      input: { memoryId: memId, loc: 'tasks:t1', name: 'T1', isRunnable: true, properties: { keep: 'me', exports: { claudeSkill: claude } } },
    }, admin())
  ).id;
});

describe('updateTaskNode with mergeExports (#1291)', () => {
  it('adds a host and keeps the sibling host and every unnamed key', async () => {
    await merge({ exports: { codexSkill: codex } });
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude, codexSkill: codex } });
  });

  it('merges one host field by field', async () => {
    await merge({ exports: { claudeSkill: { enable: false } } });
    expect((await props()).exports.claudeSkill).toEqual({ ...claude, enable: false });
  });

  it('null removes a host', async () => {
    await merge({ exports: { claudeSkill: null } });
    expect((await props()).exports).toEqual({});
    expect((await props()).keep).toBe('me');
  });

  it('a named non-exports key is replaced whole; unnamed keys survive', async () => {
    await merge({ other: { a: 1 } });
    expect(await props()).toEqual({ keep: 'me', other: { a: 1 }, exports: { claudeSkill: claude } });
  });

  it('option off is today\'s whole-bag replace', async () => {
    await M.updateTaskNode({}, { input: { id: taskId, properties: { exports: { codexSkill: codex } } } }, admin());
    expect(await props()).toEqual({ exports: { codexSkill: codex } });
    await M.updateTaskNode({}, { input: { id: taskId, properties: { x: 1 } }, mergeExports: false }, admin());
    expect(await props()).toEqual({ x: 1 });
  });

  it('two concurrent writes to different hosts both land', async () => {
    const hosts = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    await Promise.all(hosts.map((h) => merge({ exports: { [h]: { name: h, description: `Use when ${h}.`, enable: true } } })));
    const exp = (await props()).exports;
    for (const h of hosts) expect(exp[h]?.name).toBe(h);
    expect(exp.claudeSkill).toEqual(claude);
  });

  it('concurrent writes to different fields of one host both land', async () => {
    await Promise.all([
      merge({ exports: { claudeSkill: { enable: false } } }),
      merge({ exports: { claudeSkill: { description: 'Use when changed.' } } }),
      merge({ exports: { claudeSkill: { extra: 1 } } }),
    ]);
    expect((await props()).exports.claudeSkill).toEqual({ ...claude, enable: false, description: 'Use when changed.', extra: 1 });
  });

  it('refuses a non-object properties patch with BAD_USER_INPUT, writing nothing', async () => {
    for (const bad of [null, [1], 'x', 3]) {
      await expect(merge(bad)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude } });
  });

  it('a non-object exports in the patch replaces the stored value (existing rule)', async () => {
    await merge({ exports: null });
    expect((await props()).exports).toBeNull();
  });

  it('with no properties in the input, the option changes nothing', async () => {
    await M.updateTaskNode({}, { input: { id: taskId, description: 'd' }, mergeExports: true }, admin());
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude } });
  });

  it('refuses a patch whose MERGED result violates the memory schema, whole', async () => {
    await M.updateMemory(null, {
      ref: memId,
      schema: { objectTypes: { task: { strict: false, fields: { title: { type: 'text', required: true } } } } },
    }, admin());
    const typed = await M.createTaskNode({}, {
      input: { memoryId: memId, loc: 'tasks:typed', name: 'Typed', isRunnable: true, objectType: 'task', properties: { title: 'T' } },
    }, admin());
    await expect(
      M.updateTaskNode({}, { input: { id: typed.id, properties: { title: null, exports: { codexSkill: codex } } }, mergeExports: true }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: typed.id } })).properties).toEqual({ title: 'T' });
  });

  it('honours expectedRevision with the option on', async () => {
    const rev = (await db.node.findUniqueOrThrow({ where: { id: taskId } })).revSeq;
    await expect(merge({ exports: { codexSkill: codex } }, { expectedRevision: rev + 5 })).rejects.toMatchObject({
      extensions: { code: 'NODE_WRITE_CONFLICT' },
    });
    expect((await props()).exports.codexSkill).toBeUndefined();
    await merge({ exports: { codexSkill: codex } }, { expectedRevision: rev });
    expect((await props()).exports.codexSkill).toEqual(codex);
  });

  it('a caller without write access is refused identically with the option on or off, and nothing changes', async () => {
    const off = await M.updateTaskNode({}, { input: { id: taskId, properties: { exports: { codexSkill: codex } } } }, outsider()).catch((e) => e);
    const on = await merge({ exports: { codexSkill: codex } }, {}, outsider()).catch((e) => e);
    expect(on.extensions?.code).toBe(off.extensions?.code);
    expect(on.message).toBe(off.message);
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude } });
  });

  it('refuses a caller without write access BEFORE taking the node lock (nothing of the stored bag is read for them)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await gotLock;
    try {
      const outcome = await Promise.race([
        merge({ exports: { codexSkill: codex } }, {}, outsider()).then(() => 'wrote', (e) => `refused:${e.extensions?.code}`),
        new Promise<string>((r) => setTimeout(() => r('blocked on the lock'), 2_000)),
      ]);
      expect(outcome).toMatch(/^refused:/);
    } finally {
      release();
      await holder;
    }
  });

  it('never makes a non-task node writable through the door (the kind is the door\'s, not the caller\'s)', async () => {
    const plain = await M.createNode({}, { input: { memoryId: memId, loc: 'notes:n1', name: 'N', properties: { a: 1 } } }, admin());
    // The plain node is not a task: the task door still merges it as it would update it, and refuses to make it a review.
    await expect(
      M.updateTaskNode({}, { input: { id: plain.id, properties: { exports: {} }, role: 'review' }, mergeExports: true }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
  });
});

describe('the option lives on updateTaskNode only (#1291)', () => {
  const server = new ApolloServer<Context>({ typeDefs, resolvers });
  it('is a documented Boolean argument of updateTaskNode', async () => {
    const r = await server.executeOperation({
      query: '{ __type(name: "Mutation") { fields { name args { name description type { name kind } } } } }',
    });
    const fields = (r.body as any).singleResult.data.__type.fields as Array<{ name: string; args: Array<{ name: string; description: string | null; type: { name: string | null } }> }>;
    const arg = fields.find((f) => f.name === 'updateTaskNode')!.args.find((a) => a.name === 'mergeExports');
    expect(arg?.type.name).toBe('Boolean');
    expect(arg?.description).toContain('exports');
    for (const name of ['updateNode', 'updateReviewNode', 'updateSpecNode', 'amendQuestion']) {
      expect(fields.find((f) => f.name === name)?.args.map((a) => a.name)).not.toContain('mergeExports');
    }
  });

  it('is not a field of the shared UpdateNodeInput', async () => {
    const r = await server.executeOperation({ query: '{ __type(name: "UpdateNodeInput") { inputFields { name } } }' });
    const names = ((r.body as any).singleResult.data.__type.inputFields as Array<{ name: string }>).map((f) => f.name);
    expect(names).not.toContain('mergeExports');
  });

  it('the review and spec doors ignore a smuggled option: whole-bag replace', async () => {
    const rev = await M.createReviewNode({}, { input: { memoryId: memId, loc: 'rev:r1', name: 'R', role: 'review', properties: { a: 1, b: 2 } } }, admin());
    await M.updateReviewNode({}, { input: { id: rev.id, properties: { a: 9 } }, mergeExports: true }, admin());
    expect((await db.node.findUniqueOrThrow({ where: { id: rev.id } })).properties).toEqual({ a: 9 });
  });
});

describe('hadron_update_task mirrors the option (#1291)', () => {
  const auth = () => ({ userId: adminId, roles: ['ADMIN'] as const, clientId: `user:${adminId}` });
  it('merges when mergeExports is true and replaces when it is omitted', async () => {
    const s = createTestableMcpServer(auth() as never);
    const urn = (await db.node.findUniqueOrThrow({ where: { id: taskId }, include: { memory: true } }));
    const nodeUrn = `hrn:node:${urn.memory.urn.split(':')[0]}:${urn.memory.urn.split(':').slice(1).join(':')}:${urn.loc}`;
    await s.callToolText('hadron_update_task', { urn: nodeUrn, properties: { exports: { codexSkill: codex } }, mergeExports: true });
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude, codexSkill: codex } });
    await s.callToolText('hadron_update_task', { urn: nodeUrn, properties: { only: 1 } });
    expect(await props()).toEqual({ only: 1 });
  });
});
