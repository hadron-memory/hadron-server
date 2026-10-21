/**
 * Removal of governed nodes through the generic surface.
 *
 * A node of a governed kind (a runnable task, a `review`, a `spec` family role)
 * is written through its own door. Generic removal follows the same rule: the
 * generic delete surfaces refuse a governed node, and refuse an operation whose
 * affected set REACHES one (an ancestor, a recursive subtree, a folded source),
 * judged over the whole set under the write's locks. To remove a governed node,
 * clear its marker through the kind's update door first, then delete it as an
 * ordinary node.
 *
 * What must hold, one case each:
 *   1. The target itself, soft and hard, per kind.
 *   2. An ancestor / recursive subtree that CONTAINS one, even when it is not
 *      the named target; nothing is written when it refuses.
 *   3. Ordinary-only subtrees keep deleting (positive controls).
 *   4. Clear-first works through the kind's door and honours its writer level.
 *   5. The same on the MCP delete, which is an independent inline transaction.
 *   6. A folded merge source that would be removed.
 *   7. A refusal discloses nothing to a caller who cannot see the memory.
 *   8. A marker edit racing the delete is decided under row locks, in both
 *      orders: committed first it is seen and refuses; arriving after the
 *      delete holds the rows it waits for the delete to finish.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let memoryId: string;
let adminId: string;
let contribId: string;
let readerId: string;

const asUser = (id: string, roles: Context['roles'] = []): Context => ({ db, roles, userId: id, clientId: `user:${id}` });
const ctx = (): Context => asUser(adminId, ['ADMIN']);
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}

const node = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: 'body', ...extra } });
const at = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc } });
const delById = async (loc: string, opts: { hard?: boolean; recursive?: boolean } = {}, c: Context = ctx()) => {
  const n = await at(loc);
  return code(resolvers.Mutation.deleteNode({}, { nodeRef: n.id, ...opts } as never, c));
};

/** Everything a refused removal must leave alone. */
async function snapshot() {
  const nodes = await db.node.findMany({
    where: { memoryId },
    orderBy: { loc: 'asc' },
    select: { id: true, loc: true, role: true, isRunnable: true, deletedAt: true },
  });
  return {
    nodes,
    revisions: await db.nodeRevision.count({ where: { node: { memoryId } } }),
    edges: await db.edge.count({ where: { source: { memoryId } } }),
  };
}

const nodeUrn = (loc: string) => `hrn:node:gov-org.test:corpus:${loc}`;
const mcp = (userId = adminId, roles: string[] = ['ADMIN']) =>
  createTestableMcpServer({ userId, roles: roles as never, clientId: `user:${userId}` });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'gov-org', urn: 'gov-org.test' } });
  orgId = org.id;
  adminId = (await db.user.create({ data: { id: generateId(), githubId: 12020, githubUsername: 'rm-admin', roles: ['ADMIN'] } })).id;
  contribId = (await db.user.create({ data: { id: generateId(), githubId: 12021, githubUsername: 'rm-contrib' } })).id;
  readerId = (await db.user.create({ data: { id: generateId(), githubId: 12022, githubUsername: 'rm-reader' } })).id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: adminId, role: 'ADMIN' },
      { organizationId: orgId, userId: contribId, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: readerId, role: 'READER' },
    ],
  });
  memoryId = (await resolvers.Mutation.createMemory({}, { orgId, name: 'corpus' }, ctx())).id;
});

const GOVERNED: Array<[string, Record<string, unknown>]> = [
  ['a review', { role: 'review' }],
  ['a review family role', { role: 'review.security' }],
  ['a spec', { role: 'spec' }],
  ['a spec family role', { role: 'spec.rule.detail' }],
  ['a runnable task', { isRunnable: true }],
];

describe('GraphQL deleteNode: a governed target', () => {
  for (const [label, signal] of GOVERNED) {
    for (const hard of [false, true]) {
      it(`refuses ${hard ? 'hard' : 'soft'} delete of ${label} and writes nothing`, async () => {
        await node('t:1', signal);
        await node('t:2');
        const before = await snapshot();
        expect(await delById('t:1', { hard })).toBe('ROLE_GOVERNED');
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('names the clear-first route and carries typed extensions', async () => {
    const n = await node('t:1', { role: 'review' });
    let err: GraphQLError | undefined;
    try {
      await resolvers.Mutation.deleteNode({}, { nodeRef: n.id } as never, ctx());
    } catch (e) {
      err = e as GraphQLError;
    }
    expect(err?.extensions).toMatchObject({ code: 'ROLE_GOVERNED', kind: 'review', op: 'delete', refusal: 'removes' });
    expect(err?.message).toMatch(/clear/i);
    expect(err?.message).toMatch(/updateReviewNode/);
  });
});

describe('GraphQL deleteNode: an affected set that reaches a governed node', () => {
  for (const hard of [false, true]) {
    it(`refuses a recursive ${hard ? 'hard' : 'soft'} ancestor delete when a deep descendant is governed`, async () => {
      await node('a');
      await node('a:b');
      await node('a:b:c');
      await node('a:b:c:review', { role: 'review' });
      await node('a:other');
      const before = await snapshot();
      expect(await delById('a', { hard, recursive: true })).toBe('ROLE_GOVERNED');
      expect(await snapshot()).toEqual(before);
    });
  }

  it('still reports NODE_HAS_DESCENDANTS for a non-recursive ancestor delete', async () => {
    await node('a');
    await node('a:r', { role: 'review' });
    expect(await delById('a')).toBe('NODE_HAS_DESCENDANTS');
  });

  it('a tombstoned governed descendant blocks a HARD recursive delete but not a SOFT one', async () => {
    await node('a');
    await node('a:gone', { role: 'review', deletedAt: new Date() });
    const before = await snapshot();
    expect(await delById('a', { hard: true, recursive: true })).toBe('ROLE_GOVERNED');
    expect(await snapshot()).toEqual(before);
    expect(await delById('a', { recursive: true })).toBe('OK');
    expect((await at('a')).deletedAt).not.toBeNull();
  });

  it('judges the whole set: one governed node among many ordinary ones refuses all of them', async () => {
    await node('big');
    for (let i = 0; i < 12; i++) await node(`big:n${i}`);
    await node('big:n7:inner', { isRunnable: true });
    const before = await snapshot();
    expect(await delById('big', { recursive: true })).toBe('ROLE_GOVERNED');
    expect(await snapshot()).toEqual(before);
  });
});

describe('GraphQL deleteNode: ordinary subtrees are unaffected', () => {
  for (const hard of [false, true]) {
    it(`deletes an ordinary-only subtree (${hard ? 'hard' : 'soft'})`, async () => {
      await node('o');
      await node('o:1');
      await node('o:1:2', { role: 'note' });
      await node('keep', { role: 'review' });
      expect(await delById('o', { hard, recursive: true })).toBe('OK');
      if (hard) expect(await db.node.count({ where: { memoryId, loc: { startsWith: 'o' } } })).toBe(0);
      else expect((await db.node.findMany({ where: { memoryId, loc: { startsWith: 'o' } } })).every((n) => n.deletedAt)).toBe(true);
      expect((await at('keep')).deletedAt).toBeNull();
    });
  }

  it('a role that merely starts with a governed word is ordinary', async () => {
    await node('p:1', { role: 'special' });
    await node('p:2', { role: 'reviewer' });
    expect(await delById('p:1')).toBe('OK');
    expect(await delById('p:2', { hard: true })).toBe('OK');
  });
});

describe('clear-first: the kind update door, then an ordinary delete', () => {
  it('retires a task through its door, then deletes it', async () => {
    expect(await code(M.createTaskNode({}, { input: { memoryId, loc: 'c:task', name: 't', isRunnable: true } }, ctx()))).toBe('OK');
    expect(await delById('c:task')).toBe('ROLE_GOVERNED');
    expect(await code(M.updateTaskNode({}, { input: { memoryId, loc: 'c:task', isRunnable: false } }, ctx()))).toBe('OK');
    expect(await delById('c:task')).toBe('OK');
  });

  it('clears a review through its door, then deletes it', async () => {
    expect(await code(M.createReviewNode({}, { input: { memoryId, loc: 'c:rev', name: 'r', role: 'review' } }, ctx()))).toBe('OK');
    expect(await delById('c:rev', { hard: true })).toBe('ROLE_GOVERNED');
    expect(await code(M.updateReviewNode({}, { input: { memoryId, loc: 'c:rev', role: null } }, ctx()))).toBe('OK');
    expect(await delById('c:rev', { hard: true })).toBe('OK');
  });

  it('a writer without the kind\'s writer level cannot use the sequence', async () => {
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'review', writers: 'ADMIN' } });
    await node('w:rev', { role: 'review' });
    // The contributor can neither delete it nor clear it...
    expect(await delById('w:rev', {}, asUser(contribId))).toBe('ROLE_GOVERNED');
    expect(await code(M.updateReviewNode({}, { input: { memoryId, loc: 'w:rev', role: null } }, asUser(contribId)))).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    expect((await at('w:rev')).role).toBe('review');
    expect(await delById('w:rev', {}, asUser(contribId))).toBe('ROLE_GOVERNED');
    // ...while the ADMIN can do both, in order.
    expect(await code(M.updateReviewNode({}, { input: { memoryId, loc: 'w:rev', role: null } }, asUser(adminId, ['ADMIN'])))).toBe('OK');
    expect(await delById('w:rev', {}, asUser(contribId))).toBe('OK');
  });
});

describe('concealment: a refusal tells an unauthorised caller nothing', () => {
  it('answers a reader exactly as it answers for an ordinary ancestor, naming no descendant', async () => {
    await node('hid');
    await node('hid:secret-review', { role: 'review' });
    await node('plain');
    await node('plain:x');
    const governedAncestor = await captured(delById('hid', { recursive: true }, asUser(readerId)));
    const ordinaryAncestor = await captured(delById('plain', { recursive: true }, asUser(readerId)));
    expect(governedAncestor.code).toBe(ordinaryAncestor.code);
    expect(governedAncestor.code).not.toBe('ROLE_GOVERNED');
    expect(governedAncestor.message).not.toContain('secret-review');
  });
});

async function captured(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
    return { code: 'OK', message: '' };
  } catch (e) {
    return e instanceof GraphQLError ? { code: String(e.extensions.code), message: e.message } : { code: 'RAW', message: (e as Error).message };
  }
}

describe('MCP hadron_delete_node: an independent transaction with the same rule', () => {
  for (const [label, signal] of GOVERNED) {
    for (const hard of [false, true]) {
      it(`refuses ${hard ? 'hard' : 'soft'} delete of ${label} and writes nothing`, async () => {
        await node('t:1', signal);
        const before = await snapshot();
        const text = await mcp().callToolText('hadron_delete_node', { urn: nodeUrn('t:1'), hard });
        expect(text).toContain('ROLE_GOVERNED');
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  for (const hard of [false, true]) {
    it(`refuses a recursive ${hard ? 'hard' : 'soft'} ancestor delete over a governed descendant`, async () => {
      await node('a');
      await node('a:b');
      await node('a:b:r', { role: 'spec.rule' });
      const before = await snapshot();
      const text = await mcp().callToolText('hadron_delete_node', { urn: nodeUrn('a'), hard, recursive: true });
      expect(text).toContain('ROLE_GOVERNED');
      expect(await snapshot()).toEqual(before);
    });
  }

  it('deletes an ordinary-only subtree and a cleared node', async () => {
    await node('o');
    await node('o:1');
    expect(await mcp().callToolText('hadron_delete_node', { urn: nodeUrn('o'), recursive: true })).not.toContain('ROLE_GOVERNED');
    expect((await at('o')).deletedAt).not.toBeNull();
    await node('c', { isRunnable: true });
    expect(await mcp().callToolText('hadron_delete_node', { urn: nodeUrn('c') })).toContain('ROLE_GOVERNED');
    await db.node.update({ where: { id: (await at('c')).id }, data: { isRunnable: false } });
    expect(await mcp().callToolText('hadron_delete_node', { urn: nodeUrn('c') })).not.toContain('ROLE_GOVERNED');
    expect((await at('c')).deletedAt).not.toBeNull();
  });
});

describe('MCP hadron_move_node overwrite: evicting the occupant is a removal', () => {
  const move = (from: string, to: string, userId = adminId, roles: string[] = ['ADMIN']) =>
    mcp(userId, roles).callToolText('hadron_move_node', { urn: nodeUrn(from), targetUrn: nodeUrn(to), overwrite: true });

  for (const [label, signal] of GOVERNED) {
    it(`refuses to evict ${label} and writes nothing`, async () => {
      await node('mv:src');
      await node('mv:dst', signal);
      const before = await snapshot();
      expect(await move('mv:src', 'mv:dst')).toContain('ROLE_GOVERNED');
      expect(await snapshot()).toEqual(before);
    });
  }

  it('refuses for a plain memory writer too, not only an admin', async () => {
    await node('mv:src');
    await node('mv:dst', { role: 'review' });
    const before = await snapshot();
    expect(await move('mv:src', 'mv:dst', contribId, [])).toContain('ROLE_GOVERNED');
    expect(await snapshot()).toEqual(before);
  });

  it('still evicts an ordinary occupant', async () => {
    const src = await node('mv:src');
    const occupant = await node('mv:dst', { role: 'note' });
    expect(await move('mv:src', 'mv:dst')).not.toContain('ROLE_GOVERNED');
    expect((await db.node.findUniqueOrThrow({ where: { id: occupant.id } })).deletedAt).not.toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: src.id } })).loc).toBe('mv:dst');
  });

  it('a tombstoned governed occupant is re-keyed, not removed', async () => {
    const src = await node('mv:src');
    await node('mv:dst', { role: 'review', deletedAt: new Date() });
    expect(await move('mv:src', 'mv:dst')).not.toContain('ROLE_GOVERNED');
    expect((await db.node.findUniqueOrThrow({ where: { id: src.id } })).loc).toBe('mv:dst');
  });
});

describe('mergeNodes: a source that the fold removes', () => {
  const merge = (source: string, target: string, deleteSource: boolean) =>
    code(resolvers.Mutation.mergeNodes({}, { input: { source, target, deleteSource } } as never, ctx()));

  it('refuses deleteSource when the source is governed, and writes nothing', async () => {
    const s = await node('m:src', { role: 'review', content: 'from source' });
    const t = await node('m:dst', { content: 'dest' });
    const before = await snapshot();
    expect(await merge(s.id, t.id, true)).toBe('ROLE_GOVERNED');
    expect(await snapshot()).toEqual(before);
    expect((await at('m:dst')).content).toBe('dest');
  });

  it('still folds an ordinary source, with or without deleting it', async () => {
    const s = await node('m:s1', { content: 'one' });
    const t = await node('m:d1', { content: 'two' });
    expect(await merge(s.id, t.id, true)).toBe('OK');
    expect(await db.node.count({ where: { id: s.id } })).toBe(0);
  });

  it('keeps a governed source when it is not deleted', async () => {
    const s = await node('m:s2', { role: 'review', content: 'one' });
    const t = await node('m:d2', { content: 'two' });
    expect(await merge(s.id, t.id, false)).toBe('OK');
    expect((await at('m:s2')).role).toBe('review');
  });
});

/** A promise whose resolution the test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * The real client, except that the interactive transaction pauses once the
 * affected node rows have been locked (`FOR NO KEY UPDATE`): the removal then
 * holds its rows while the test starts a competing write, with nothing else
 * changed about the operation under test.
 */
function pausingAfterRowLock(onLocked: () => Promise<void>) {
  return new Proxy(db, {
    get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property, target);
      return (action: unknown, options?: unknown) => {
        if (typeof action !== 'function') return Reflect.apply(target.$transaction, target, [action, options]);
        return target.$transaction(async (tx) => {
          const pausing = new Proxy(tx, {
            get(t, prop) {
              if (prop !== '$queryRaw') return Reflect.get(t, prop, t);
              return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                const out = await (t.$queryRaw as (...a: unknown[]) => Promise<unknown>)(strings, ...values);
                if (strings.join('?').includes('FROM nodes') && strings.join('?').includes('FOR NO KEY UPDATE')) await onLocked();
                return out;
              };
            },
          });
          return (action as (t: unknown) => Promise<unknown>)(pausing);
        }, options as Parameters<typeof target.$transaction>[1]);
      };
    },
  });
}

describe('races: a marker edit against the removal, in both orders', () => {
  it('a marker edit that commits first is seen under the lock, and the delete refuses', async () => {
    await node('r');
    const d = await node('r:d');
    const holding = deferred();
    const release = deferred();
    // An uncommitted marker edit holds the descendant's row.
    const edit = db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: d.id }, data: { role: 'review' } });
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const parent = await at('r');
    const op = captured(resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, recursive: true } as never, ctx()));
    await waitForLockWaiters(db, 1);
    release.resolve();
    await edit;
    expect((await op).code).toBe('ROLE_GOVERNED');
    expect((await at('r')).deletedAt).toBeNull();
    expect(await at('r:d')).toMatchObject({ role: 'review', deletedAt: null });
  });

  it('a marker edit that arrives while the delete holds the rows waits, then meets the finished delete', async () => {
    await node('q');
    await node('q:d');
    const locked = deferred();
    const release = deferred();
    const paused = pausingAfterRowLock(async () => { locked.resolve(); await release.promise; });
    const parent = await at('q');
    const del = captured(resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, recursive: true } as never, { ...ctx(), db: paused }));
    await locked.promise;
    let doorDone = false;
    const door = code(M.updateReviewNode({}, { input: { memoryId, loc: 'q:d', role: 'review' } }, ctx())).then((c) => { doorDone = true; return c; });
    await waitForLockWaiters(db, 1);
    // The edit is held behind the delete's rows: it has not completed.
    expect(doorDone).toBe(false);
    release.resolve();
    expect((await del).code).toBe('OK');
    await door;
    // The delete judged the set while it held the rows: nothing was governed then.
    expect((await at('q')).deletedAt).not.toBeNull();
    expect((await at('q:d')).deletedAt).not.toBeNull();
  });

  it('overlapping recursive deletes both finish: no lock-order cycle between their locks', async () => {
    await node('x');
    await node('x:a');
    await node('x:a:b');
    await node('x:c');
    const outer = await at('x');
    const inner = await at('x:a');
    const results = await Promise.all([
      captured(resolvers.Mutation.deleteNode({}, { nodeRef: outer.id, recursive: true } as never, ctx())),
      captured(resolvers.Mutation.deleteNode({}, { nodeRef: inner.id, recursive: true } as never, ctx())),
    ]);
    // Either order is legal; a deadlock or a raw error is not.
    for (const r of results) expect(['OK', 'NODE_WRITE_CONFLICT']).toContain(r.code);
    expect((await at('x')).deletedAt).not.toBeNull();
    expect((await at('x:a:b')).deletedAt).not.toBeNull();
  });

  it('the MCP delete decides the same way when a marker edit commits first', async () => {
    await node('s');
    const d = await node('s:d');
    const holding = deferred();
    const release = deferred();
    const edit = db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: d.id }, data: { isRunnable: true } });
      holding.resolve();
      await release.promise;
    });
    await holding.promise;
    const op = mcp().callToolText('hadron_delete_node', { urn: nodeUrn('s'), recursive: true });
    await waitForLockWaiters(db, 1);
    release.resolve();
    await edit;
    expect(await op).toContain('ROLE_GOVERNED');
    expect((await at('s')).deletedAt).toBeNull();
    expect((await at('s:d')).deletedAt).toBeNull();
  });
});
