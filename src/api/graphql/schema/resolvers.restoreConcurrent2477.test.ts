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
  it('restores both requests after both read the same absent node', async () => {
    expect(await db.node.count({ where: { memoryId, loc: { in: ['alpha', 'beta'] } } })).toBe(0);

    let releaseAutoSaves!: () => void;
    const autoSavesDone = new Promise<void>(resolve => { releaseAutoSaves = resolve; });
    let releaseMissingReads!: () => void;
    const missingReadsDone = new Promise<void>(resolve => { releaseMissingReads = resolve; });
    const missingReads: Array<{ request: number; absent: boolean }> = [];
    const stages = new Map<Context['db'], { request: number; autoSaving: boolean; sawPrior: boolean }>();
    let completedAutoSaves = 0;
    let safetyReleaseExpired = false;
    // Escape hatch only: expiry must fail outside resolver error normalization,
    // even when it lets both restores finish successfully. Always release both
    // barriers so a broken fixture cannot strand its peer until the 30s timeout.
    const releaseTimer = setTimeout(() => {
      safetyReleaseExpired = true;
      releaseAutoSaves();
      releaseMissingReads();
    }, 10_000);

    const requestContexts = [0, 1].map(request => {
      const stage = { request, autoSaving: true, sawPrior: false };
      const requestDb = new Proxy(db, {
        get(target, property) {
          if (property !== '$transaction') return Reflect.get(target, property, target);
          return async (run: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) => {
            if (stage.autoSaving) return db.$transaction(run, options);
            return db.$transaction(tx => run(new Proxy(tx, {
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
                        if (missingReads.length === 2) releaseMissingReads();
                        // Hold the REAL prior-read result, not a fabricated null.
                        // Both restores now take the absent-row branch even if
                        // their writes subsequently run one after the other.
                        await missingReadsDone;
                      }
                      return result;
                    };
                  },
                });
              },
            })), options);
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
        stage.autoSaving = false;
        if (++completedAutoSaves === 2) releaseAutoSaves();
        await autoSavesDone;
        return result;
      } catch (error) {
        releaseAutoSaves();
        releaseMissingReads();
        throw error;
      }
    });

    try {
      const results = await Promise.allSettled(requestContexts.map(requestContext =>
        M.restoreRevision({}, { agentId, revisionLoc }, requestContext)));
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
      expect(missingReads.sort((a, b) => a.request - b.request)).toEqual([
        { request: 0, absent: true }, { request: 1, absent: true },
      ]);
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
      releaseMissingReads();
      autoSave.mockRestore();
    }
  }, 20_000);
});
