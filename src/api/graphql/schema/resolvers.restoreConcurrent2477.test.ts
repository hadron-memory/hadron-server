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
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Restore concurrency', visibility: 'PERSONAL' }, context);
  agentId = agent.id;
  memoryId = agent.systemMemoryId!;
  // #3833: createAgent now seeds skeleton parents. This fixture models a two-node graph (alpha, beta), and the seeded rows
  // would be row-locked by the first restore while it waits at the barrier, so start from an empty memory.
  await db.node.deleteMany({ where: { memoryId } });
  const source = await db.node.create({ data: { id: generateId(), memoryId, loc: 'alpha', name: 'Alpha', nodeType: 'system', content: 'snapshot alpha' } });
  const target = await db.node.create({ data: { id: generateId(), memoryId, loc: 'beta', name: 'Beta', nodeType: 'system', content: 'snapshot beta' } });
  await db.edge.create({ data: { id: generateId(), memoryId, loc: 'alpha:link:beta', name: 'link', sourceId: source.id, targetId: target.id } });
  const revision = await M.createRevision({}, { agentRef: agentId, description: 'two-node graph' }, context);
  revisionLoc = revision.revisionLoc;
  await db.edge.deleteMany({ where: { memoryId } });
  await db.node.deleteMany({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } });
});

describe('#2477 missing-loc concurrent restore', () => {
  it('queues restores on the memory key before the missing-loc read and both succeed', async () => {
    expect(await db.node.count({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } })).toBe(0);
    const revisionRowsBefore = await db.node.findMany({
      where: { memoryId, loc: { startsWith: 'revisions:rev-' } },
      select: { id: true, loc: true, data: true, deletedAt: true }, orderBy: { loc: 'asc' },
    });
    const autoSavedLocs: string[] = [];


    let releaseAutoSaves!: () => void;
    const autoSavesDone = new Promise<void>(resolve => { releaseAutoSaves = resolve; });
    const [{ key: memoryKey }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
    let observedQueuedPeer = false;
    const missingReads: Array<{ request: number; absent: boolean }> = [];
    const stages = new Map<Context['db'], { request: number; autoSaving: boolean; sawPrior: boolean; pid: number | null }>();
    let completedAutoSaves = 0;
    let safetyReleaseExpired = false;
    // Escape hatch only: expiry must fail outside resolver error normalization,
    // even when it lets both restores finish successfully. The read observer
    // has its own bounded poll; always release the auto-save barrier on expiry.
    const releaseTimer = setTimeout(() => {
      safetyReleaseExpired = true;
      releaseAutoSaves();
    }, 10_000);

    const requestContexts = [0, 1].map(request => {
      const stage = { request, autoSaving: true, sawPrior: false, pid: null as number | null };
      const requestDb = new Proxy(db, {
        get(target, property) {
          if (property !== '$transaction') return Reflect.get(target, property, target);
          return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) => {
            if (stage.autoSaving) return db.$transaction(run, options);
            return db.$transaction(async tx => {
              stage.pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid;
              return run(new Proxy(tx, {
                get(transaction, key) {
                  if (key !== 'node') return Reflect.get(transaction, key, transaction);
                  return new Proxy(transaction.node, {
                    get(nodes, operation) {
                      if (operation !== 'findUnique') return Reflect.get(nodes, operation, nodes);
                      return async (...args: Parameters<typeof nodes.findUnique>) => {
                        const result = await Reflect.apply(nodes.findUnique, nodes, args);
                        const query = args[0];
                        // Hook contract: first post-auto-save transactional alpha
                        // findUnique for THIS memory, with select.id === true.
                        // A changed call shape needs an explicit fixture update;
                        // do not broaden this to an unrelated read or invent null.
                        if (!stage.sawPrior && query?.where.loc_memoryId?.loc === 'alpha'
                          && query.where.loc_memoryId.memoryId === memoryId && query.select?.id === true) {
                          stage.sawPrior = true;
                          missingReads.push({ request, absent: result === null });
                          if (missingReads.length === 1) {
                            // S2 serializes these owning writers before any node read.
                            // Prove the peer is waiting on THIS key and this holder,
                            // rather than waiting for a second absent read that cannot occur.
                            const deadline = Date.now() + 5_000;
                            while (Date.now() < deadline) {
                              const peer = [...stages.values()].find(value => value.request !== request);
                              if (peer?.pid) {
                                const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
                                  SELECT 1 FROM pg_locks WHERE pid = ${peer.pid}::int
                                  AND locktype = 'advisory' AND NOT granted
                                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                                  AND classid = ${memoryKey < 0 ? 4294967295 : 0}::bigint::oid
                                  AND objid = ${memoryKey >>> 0}::bigint::oid AND objsubid = 1
                                  AND ${stage.pid}::int = ANY(pg_blocking_pids(${peer.pid}::int))) AS waiting`;
                                if (row.waiting) { observedQueuedPeer = true; break; }
                              }
                              await new Promise(resolve => setTimeout(resolve, 10));
                            }
                            if (!observedQueuedPeer) throw new Error('Peer restore did not queue on the exact memory key before its node read');
                          }
                        }
                        return result;
                      };
                    },
                  });
                },
              }));
            }, options);
          };
        },
      });
      stages.set(requestDb, stage);
      return { ...context, db: requestDb };
    });

    // Isolate #2498's label allocator using two serial REAL auto-saves.
    // Preserve exactly the context passed by restoreRevision, including its DB.
    const createRevision = sessionMutations.createRevision.bind(sessionMutations);
    let autoSaveQueue = Promise.resolve();
    const autoSave = vi.spyOn(sessionMutations, 'createRevision').mockImplementation(async (...args) => {
      const stage = stages.get(args[2].db);
      if (!stage) throw new Error('Unexpected auto-save database context');
      const saved = autoSaveQueue.then(() => createRevision(...args));
      autoSaveQueue = saved.then(() => undefined, () => undefined);
      try {
        const result = await saved;
        autoSavedLocs.push(result.revisionLoc);
        stage.autoSaving = false;
        if (++completedAutoSaves === 2) releaseAutoSaves();
        await autoSavesDone;
        return result;
      } catch (error) {
        releaseAutoSaves();
        throw error;
      }
    });

    try {
      const results = await Promise.allSettled(requestContexts.map(requestContext =>
        M.restoreRevision({}, { agentRef: agentId, revisionLoc }, requestContext)));
      // Assertions live outside resolver callbacks, so an error wrapper cannot
      // turn a failed fixture precondition into an accepted typed outcome.
      const fixtureFailures: Error[] = [];
      for (const stage of stages.values()) {
        if (!stage.sawPrior) fixtureFailures.push(new Error(
          `Request ${stage.request}: missing first transactional alpha/this-memory/select.id prior-read hook ` +
          `(phase: ${stage.autoSaving ? 'real auto-save not completed' : 'restore after real auto-save'}). ` +
          'Update the exact fixture matcher if the production call shape changed.',
        ));
      }
      if (safetyReleaseExpired) fixtureFailures.push(new Error(
        '10s safety-release timer expired; normal barrier release did not complete. ' +
        `Completed real auto-saves: ${completedAutoSaves}/2; observed prior-read hooks: ${missingReads.length}/2.`,
      ));
      if (fixtureFailures.length) {
        // Preserve resolver failures alongside diagnostics rather than replacing
        // an original rejection with a generic late observation mismatch.
        const originals = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        throw new AggregateError([...originals, ...fixtureFailures],
          `Restore race fixture contract failed: ${fixtureFailures.map(error => error.message).join(' ')}`);
      }
      expect(completedAutoSaves).toBe(2);
      expect(autoSave).toHaveBeenCalledTimes(2);
      // The original contract is two successful requests, each with one real
      // auto-save: no lost revision, duplicated save or overwritten old slot.
      // S2 retires only the simultaneous absent-read barrier, not that property.
      expect(autoSavedLocs).toHaveLength(2);
      expect(new Set(autoSavedLocs).size).toBe(2);
      const revisionRowsAfter = await db.node.findMany({
        where: { memoryId, loc: { startsWith: 'revisions:rev-' } },
        select: { id: true, loc: true, data: true, deletedAt: true }, orderBy: { loc: 'asc' },
      });
      expect(revisionRowsAfter.map(row => row.loc)).toEqual(
        [...revisionRowsBefore.map(row => row.loc), ...autoSavedLocs].sort(),
      );
      for (const row of revisionRowsBefore) expect(revisionRowsAfter.find(after => after.loc === row.loc)).toEqual(row);
      for (const loc of autoSavedLocs) expect(revisionRowsAfter.find(row => row.loc === loc)?.deletedAt).toBeNull();

      expect(observedQueuedPeer).toBe(true);
      expect(missingReads.map(read => read.absent)).toEqual([true, false]);
      expect(new Set(missingReads.map(read => read.request)).size).toBe(2);
      // Pin existing successful behavior, not an unspecified refusal contract.
      // ANY rejection fails, including generic or nested/wrapped P2002 errors.
      const rejections = results.flatMap(result => result.status === 'rejected' ? [{
        code: result.reason?.code,
        typedCode: result.reason?.extensions?.code,
        originalCode: result.reason?.originalError?.code,
        causeCode: result.reason?.cause?.code,
      }] : []);
      expect(rejections, 'Both restores must succeed, including through error wrappers').toEqual([]);
      expect(results).toMatchObject([
        { status: 'fulfilled', value: { revisionLoc, published: false } },
        { status: 'fulfilled', value: { revisionLoc, published: false } },
      ]);
      expect(await db.node.findMany({ where: { memoryId, deletedAt: null, loc: { in: ['alpha', 'beta'] } }, select: { loc: true, content: true }, orderBy: { loc: 'asc' } }))
        .toEqual([{ loc: 'alpha', content: 'snapshot alpha' }, { loc: 'beta', content: 'snapshot beta' }]);
      const edges = await db.edge.findMany({ where: { memoryId, loc: 'alpha:link:beta', deletedAt: null }, include: { source: true, target: true } });
      expect(edges).toHaveLength(1);
      expect(edges[0].source.loc).toBe('alpha');
      expect(edges[0].target.loc).toBe('beta');
      // alpha/beta have no strict ancestors: this pin covers atomic upsert,
      // not lockAncestorsForCreateMany. The separate auto-save race is #2498.
    } finally {
      clearTimeout(releaseTimer);
      releaseAutoSaves();
      autoSave.mockRestore();
    }
  }, 20_000);
});
