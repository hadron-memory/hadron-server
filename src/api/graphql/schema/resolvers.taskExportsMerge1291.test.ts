/**
 * #1291 — an atomic `exports` merge through the governed task door.
 *
 * `updateTaskNode(input, mergeExports: true)` treats `input.properties` as a PATCH merged by `mergePropertiesPatch`
 * (the function `updateNodeProperties` uses) under the node's advisory lock, on the row read after the lock. With the
 * option off the door replaces the whole bag, as before. The option lives on the task door's own argument, never on
 * the shared `UpdateNodeInput`, so no other door gains a merge mode.
 */
import { activeMemoryWriteGrant, revokeGrantRow } from '../../../test/appGrants5404.js';
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
  M.updateTaskNode({}, { input: { ref: taskId, properties, ...extra }, mergeExports: true }, ctx);
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
      input: { memoryRef: memId, loc: 'tasks:t1', name: 'T1', isRunnable: true, properties: { keep: 'me', exports: { claudeSkill: claude } } },
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
    await M.updateTaskNode({}, { input: { ref: taskId, properties: { exports: { codexSkill: codex } } } }, admin());
    expect(await props()).toEqual({ exports: { codexSkill: codex } });
    await M.updateTaskNode({}, { input: { ref: taskId, properties: { x: 1 } }, mergeExports: false }, admin());
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
    await M.updateTaskNode({}, { input: { ref: taskId, description: 'd' }, mergeExports: true }, admin());
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude } });
  });

  it('refuses a patch whose MERGED result violates the memory schema, whole', async () => {
    await M.updateMemory(null, {
      ref: memId,
      schema: { objectTypes: { task: { strict: false, fields: { title: { type: 'text', required: true } } } } },
    }, admin());
    const typed = await M.createTaskNode({}, {
      input: { memoryRef: memId, loc: 'tasks:typed', name: 'Typed', isRunnable: true, objectType: 'task', properties: { title: 'T' } },
    }, admin());
    await expect(
      M.updateTaskNode({}, { input: { ref: typed.id, properties: { title: null, exports: { codexSkill: codex } } }, mergeExports: true }, admin()),
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
    const off = await M.updateTaskNode({}, { input: { ref: taskId, properties: { exports: { codexSkill: codex } } } }, outsider()).then(() => null, (e) => e);
    const on = await merge({ exports: { codexSkill: codex } }, {}, outsider()).then(() => null, (e) => e);
    expect(off).not.toBeNull();
    expect(on).not.toBeNull();
    expect(off.extensions?.code).toBe('NODE_NOT_FOUND'); // an unreadable node is concealed as a missing one
    expect(on.extensions?.code).toBe('NODE_NOT_FOUND');
    expect(on.message).toBe(off.message);
    expect(await props()).toEqual({ keep: 'me', exports: { claudeSkill: claude } });
  });

  it('a malformed patch from a caller without write access is refused as any patch is (BLIND P2), by id and by loc', async () => {
    const plainId = await M.updateTaskNode({}, { input: { ref: taskId, properties: { exports: {} } } }, outsider()).then(() => null, (e) => e);
    const plainLoc = await M.updateTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:t1', properties: { exports: {} } } }, outsider()).then(() => null, (e) => e);
    const asId = (properties: unknown) => merge(properties, {}, outsider()).then(() => null, (e) => e);
    const asLoc = (properties: unknown) =>
      M.updateTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:t1', properties }, mergeExports: true }, outsider()).then(() => null, (e) => e);
    expect(plainId?.extensions?.code).toBe('NODE_NOT_FOUND');
    expect(plainLoc?.message).toMatch(/^MEMORY_NOT_FOUND:/); // a loc selector on an unreadable memory is concealed as a missing memory
    for (const [call, plain] of [[asId, plainId], [asLoc, plainLoc]] as const) {
      for (const properties of [{ exports: {} }, null, [1], 'x']) {
        const got = await call(properties);
        expect(got).not.toBeNull();
        expect(got.extensions?.code).toBe(plain.extensions?.code);
        expect(got.extensions?.code).not.toBe('BAD_USER_INPUT');
        expect(got.message).toBe(plain.message);
        if (call === asLoc) expect(got.message).toMatch(/^MEMORY_NOT_FOUND:/);
      }
    }
  });

  it('a loc selector naming no node is NODE_NOT_FOUND and creates nothing (BLIND P2)', async () => {
    await expect(
      M.updateTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:nope', properties: { a: 1 } }, mergeExports: true }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect(await db.node.count({ where: { memoryId: memId, loc: 'tasks:nope' } })).toBe(0);
  });

  it('a node created at a missing loc in the gap is not overwritten by the patch (BLIND P2)', async () => {
    const real = db.node.findFirst.bind(db.node);
    let raced = false;
    const spy = vi.spyOn(db.node, 'findFirst').mockImplementation(((args: any) => {
      const out = real(args);
      if (!raced && args?.where?.loc === 'tasks:gap') {
        raced = true;
        return out.then(async (found: unknown) => {
          await M.createTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:gap', name: 'Gap', isRunnable: true, properties: { x: 1 } } }, admin());
          return found;
        });
      }
      return out;
    }) as never);
    try {
      await expect(
        M.updateTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:gap', properties: { a: 1 } }, mergeExports: true }, admin()),
      ).rejects.toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    const gap = await db.node.findFirstOrThrow({ where: { memoryId: memId, loc: 'tasks:gap' } });
    expect(gap.properties).toEqual({ x: 1 });
  });

  /** Holds the node's lock, lets the merge resolve its loc selector and queue behind it, then runs `whileHeld` and commits. */
  async function mergeBehindLock(whileHeld: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
    const real = db.node.findFirst.bind(db.node);
    let looked!: () => void;
    const lookedUp = new Promise<void>((r) => (looked = r));
    const spy = vi.spyOn(db.node, 'findFirst').mockImplementation(((args: any) => {
      const out = real(args);
      if (args?.where?.loc === 'tasks:t1' && args?.where?.deletedAt === null) return out.then((x: unknown) => { looked(); return x; });
      return out;
    }) as never);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`;
      locked();
      await held;
      await whileHeld(tx);
    }, { timeout: 20_000 });
    try {
      await gotLock;
      const attempt = M.updateTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:t1', properties: { exports: { codexSkill: codex } } }, mergeExports: true }, admin())
        .then(() => 'wrote', (e) => `refused:${e.extensions?.code}`);
      // The merge now holds the original id and is queued on the lock. Bounded and raced with the merge settling early,
      // so a merge that never reaches the lookup fails the test instead of hanging it with the spy installed.
      // The lookup signal must WIN: an early settlement or a timeout is a failure here, never a silent pass that skipped
      // the stale-resolution path (BLIND P3). The timer is cleared either way.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = await Promise.race([
        lookedUp.then(() => 'looked-up' as const),
        attempt.then((o) => `settled-early:${o}` as const),
        new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), 10_000); }),
      ]).finally(() => clearTimeout(timer));
      if (seen !== 'looked-up') throw new Error(`the merge did not reach its loc lookup while the lock was held (${seen})`);
      release();
      await holder;
      return await attempt;
    } finally {
      release();
      await holder.catch(() => undefined);
      spy.mockRestore();
    }
  }

  it('a loc-selected merge does not follow a node that moved while it waited for the lock (BLIND P2)', async () => {
    const outcome = await mergeBehindLock(async (tx) => { await tx.node.update({ where: { id: taskId }, data: { loc: 'tasks:moved' } }); });
    expect(outcome).toBe('refused:NODE_NOT_FOUND');
    expect((await props()).exports.codexSkill).toBeUndefined();
  });

  it('a loc-selected merge lands on the replacement when the original row is physically deleted (BLIND delta P2)', async () => {
    const repl = await M.createTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:repl', name: 'Repl', isRunnable: true, properties: { keep: 'repl' } } }, admin());
    const outcome = await mergeBehindLock(async (tx) => {
      await tx.node.delete({ where: { id: taskId } });
      await tx.node.update({ where: { id: repl.id }, data: { loc: 'tasks:t1' } });
    });
    expect(outcome).toBe('wrote');
    expect((await db.node.findUniqueOrThrow({ where: { id: repl.id } })).properties).toEqual({ keep: 'repl', exports: { codexSkill: codex } });
  });

  it('an id-selected merge on a physically deleted row is NODE_NOT_FOUND at once, never routed through the loc retry (SEC note)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${taskId}))`;
      locked();
      await held;
      await tx.node.delete({ where: { id: taskId } });
    }, { timeout: 20_000 });
    try {
      await gotLock;
      const attempt = merge({ exports: { codexSkill: codex } }).then(() => 'wrote', (e) => `refused:${e.extensions?.code}`);
      await new Promise((r) => setTimeout(r, 500)); // queued on the lock behind the holder
      release();
      await holder;
      expect(await attempt).toBe('refused:NODE_NOT_FOUND');
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  });

  it('a loc-selected merge lands on the node that took the loc when the original moved away (BLIND delta P2)', async () => {
    const repl = await M.createTaskNode({}, { input: { memoryRef: memId, loc: 'tasks:repl', name: 'Repl', isRunnable: true, properties: { keep: 'repl' } } }, admin());
    const outcome = await mergeBehindLock(async (tx) => {
      await tx.node.update({ where: { id: taskId }, data: { loc: 'tasks:moved' } });
      await tx.node.update({ where: { id: repl.id }, data: { loc: 'tasks:t1' } });
    });
    expect(outcome).toBe('wrote');
    const landed = (await db.node.findUniqueOrThrow({ where: { id: repl.id } })).properties as Record<string, any>;
    expect(landed).toEqual({ keep: 'repl', exports: { codexSkill: codex } });
    expect((await props()).exports.codexSkill).toBeUndefined(); // the original, moved node is untouched
  });

  it('refuses a caller without write access without waiting on the node lock', async () => {
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
      expect(outcome).toBe('refused:NODE_NOT_FOUND');
    } finally {
      release();
      await holder;
    }
  });

  it('never makes a non-task node writable through the door (the kind is the door\'s, not the caller\'s)', async () => {
    const plain = await M.createNode({}, { input: { memoryRef: memId, loc: 'notes:n1', name: 'N', properties: { a: 1 } } }, admin());
    // The plain node is not a task: the task door still merges it as it would update it, and refuses to make it a review.
    await expect(
      M.updateTaskNode({}, { input: { ref: plain.id, properties: { exports: {} }, role: 'review' }, mergeExports: true }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
  });
});

describe('a userless App run under a prefix-scoped write grant (#4599 LOCAL P2)', () => {
  const PREFIX = 'reports:team-progress';
  async function setup() {
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'tm-org' } });
    const app = await db.app.create({ data: { id: generateId(), name: 'Run App', urn: 'tm-org:app', organizationId: org.id } as never });
    const mem = await db.memory.create({ data: { id: generateId(), name: 'rep', urn: 'tm-org:rep', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
    const grant = await activeMemoryWriteGrant(app.id, mem.id, { issuerUserId: adminId, prefix: PREFIX }); // #5404: signed memory.write
    const mk = (loc: string) => M.createTaskNode({}, { input: { memoryRef: mem.id, loc, name: loc, isRunnable: true, properties: { keep: 1 } } }, admin());
    const inside = await mk(`${PREFIX}:t1`);
    const outside = await mk('other:t2');
    const run = { db, clientId: 'run:r1', appId: app.id, roles: [] } as unknown as Context;
    const upd = (id: string, mergeExports: boolean) =>
      M.updateTaskNode({}, { input: { ref: id, properties: { exports: { codexSkill: codex } } }, mergeExports }, run).then(() => 'wrote', (e) => `refused:${e.extensions?.code}`);
    return { grant, inside, outside, upd };
  }

  it('a task under the granted prefix takes the merge exactly as it takes the plain update', async () => {
    const { inside, upd } = await setup();
    expect(await upd(inside.id, true)).toBe('wrote');
    expect((await db.node.findUniqueOrThrow({ where: { id: inside.id } })).properties).toEqual({ keep: 1, exports: { codexSkill: codex } });
    expect(await upd(inside.id, false)).toBe('wrote');
  });

  it('outside the prefix, and after the grant is revoked, the merge is refused exactly as the plain update is', async () => {
    const { grant, inside, outside, upd } = await setup();
    const plainOutside = await upd(outside.id, false);
    expect(plainOutside).toMatch(/^refused:/);
    expect(await upd(outside.id, true)).toBe(plainOutside);
    await revokeGrantRow(grant, adminId);
    const plainRevoked = await upd(inside.id, false);
    expect(plainRevoked).toMatch(/^refused:/);
    expect(await upd(inside.id, true)).toBe(plainRevoked);
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
    const rev = await M.createReviewNode({}, { input: { memoryRef: memId, loc: 'rev:r1', name: 'R', role: 'review', properties: { a: 1, b: 2 } } }, admin());
    await M.updateReviewNode({}, { input: { ref: rev.id, properties: { a: 9 } }, mergeExports: true }, admin());
    expect((await db.node.findUniqueOrThrow({ where: { id: rev.id } })).properties).toEqual({ a: 9 });
    const spec = await M.createSpecNode({}, { input: { memoryRef: memId, loc: 'spec:s1', name: 'S', role: 'spec', data: { version: '0.0.1' }, properties: { a: 1, b: 2 } } }, admin());
    await M.updateSpecNode({}, { input: { ref: spec.id, properties: { a: 9 } }, mergeExports: true }, admin());
    expect((await db.node.findUniqueOrThrow({ where: { id: spec.id } })).properties).toEqual({ a: 9 });
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
