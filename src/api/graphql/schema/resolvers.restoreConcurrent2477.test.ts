/** #2477 — concurrent atomic restores must not expose a raw unique violation on a missing loc. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { sessionMutations } from './resolvers.mutation.session.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation;
afterEach(() => vi.restoreAllMocks());
let context: Context;
let agentId: string;
let memoryId: string;
let revisionLoc: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Restore concurrency', urn: 'restore-2477.example' } });
  const user = await db.user.create({ data: { githubId: 2477001, githubUsername: 'restore-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  context = { db, userId: user.id, roles: ['ADMIN'] };
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Restore concurrency', visibility: 'PERSONAL' }, context);
  agentId = agent.id;
  memoryId = agent.systemMemoryId!;
  const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'alpha', name: 'Alpha', nodeType: 'system', content: 'snapshot alpha' } });
  const target = await db.node.create({ data: { id: generateId(), memoryId, loc: 'beta', name: 'Beta', nodeType: 'system', content: 'snapshot beta' } });
  await db.edge.create({ data: { id: generateId(), memoryId, loc: 'alpha:link:beta', name: 'link', sourceId: source.id, targetId: target.id } });
  const revision = await M.createRevision({}, { agentId, description: 'two-node graph' }, context);
  revisionLoc = revision.revisionLoc;
  await db.edge.deleteMany({ where: { memoryId } });
  await db.node.deleteMany({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } });
});

describe('#2477 missing-loc concurrent restore', () => {
  it('returns success or a typed outcome for both requests, never raw P2002', async () => {
    expect(await db.node.count({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } })).toBe(0);
    // Isolate the restore transaction from createRevision's separate count-based
    // label allocator: finish the two real auto-saves sequentially, then release
    // both restores together. No production restore writes are mocked.
    const createRevision = sessionMutations.createRevision.bind(sessionMutations);
    let queue = Promise.resolve();
    let completed = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const autoSave = vi.spyOn(sessionMutations, 'createRevision').mockImplementation(async (...args) => {
      const saved = queue.then(() => createRevision(args[0], args[1], { ...args[2], db }));
      queue = saved.then(() => undefined, () => undefined);
      try {
        const result = await saved;
        if (++completed === 2) release();
        await ready;
        // Neither restore has started writing while the real auto-saves run.
        expect(completed).toBe(2);
        return result;
      } catch (error) {
        // Let the peer finish even if a fixture/auto-save fails.
        release();
        throw error;
      }
    });
    // Hold two real DB transactions open at the missing-row precondition.
    // Promise.all alone would also pass if the requests happened to run serially.
    let entered = 0;
    let startRestoring!: () => void;
    const bothTransactions = new Promise<void>(resolve => { startRestoring = resolve; });
    const concurrentDb = new Proxy(db, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property, target);
        return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) =>
          db.$transaction(async tx => {
            try {
              expect(await tx.node.count({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } })).toBe(0);
              if (++entered === 2) startRestoring();
              await bothTransactions;
              expect(entered).toBe(2);
              return await run(tx);
            } catch (error) {
              startRestoring();
              throw error;
            }
          }, options);
      },
    });
    const restoreContext = { ...context, db: concurrentDb };
    const results = await Promise.allSettled([
      M.restoreRevision({}, { agentId, revisionLoc }, restoreContext),
      M.restoreRevision({}, { agentId, revisionLoc }, restoreContext),
    ]);
    expect(entered).toBe(2);
    expect(autoSave).toHaveBeenCalledTimes(2);
    expect(completed).toBe(2);
    autoSave.mockRestore();
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason.code, 'concurrent restore leaked raw Prisma P2002').not.toBe('P2002');
        expect(result.reason.extensions?.code, 'restore failure must be typed').toBeTypeOf('string');
      } else {
        expect(result.value.revisionLoc).toBe(revisionLoc);
      }
    }
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(await db.node.findMany({ where: { memoryId, deletedAt: null, loc: { in: ['alpha', 'beta'] } }, select: { loc: true, content: true }, orderBy: { loc: 'asc' } }))
      .toEqual([{ loc: 'alpha', content: 'snapshot alpha' }, { loc: 'beta', content: 'snapshot beta' }]);
    const edge = await db.edge.findFirstOrThrow({ where: { memoryId, loc: 'alpha:link:beta', deletedAt: null }, include: { source: true, target: true } });
    expect(edge.source.loc).toBe('alpha');
    expect(edge.target.loc).toBe('beta');
  });
});
