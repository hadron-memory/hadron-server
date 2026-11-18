/**
 * #4276 (follow-up to #4271 / #4272's blind F2) — `withSharedWorkerActivity` shares ONE App-wide activity fold across
 * the liveness reads inside one roster transaction. Each boundary below falls through to an ordinary query; a share
 * used past one of them would answer a read from the wrong instant, the wrong App, another request, or a finished
 * read. The answers would often LOOK the same, so the pins count the folds actually run (the #2278 count pin's hook).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { loadAppWorkerActivity, loadWorkersActivity, withSharedWorkerActivity } from './resolvers.worker.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;

let folds = 0;
/** The shared client with a hook counting activity folds (the aggregate selects bindingModel; nothing else does). */
const traced = db.$extends({ query: { $allOperations: async ({ args, operation, query }) => {
  if (operation === '$queryRaw' && JSON.stringify(args).includes('bindingModel')) folds++;
  return query(args);
} } });

let app: { id: string };
let other: { id: string };
let kit: string;
let zed: string;
const now = new Date();
const later = new Date(now.getTime() + 60_000);

const read = (c: unknown, ids: string[], at = now) => loadWorkersActivity({ db: c } as unknown as Context, ids, at);
/** One transaction on the traced client; the fold count starts at zero inside it. */
// The extended client's transaction is a TransactionClient at runtime; its static type is the extension's.
const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  traced.$transaction(async (tx) => { folds = 0; return fn(tx as unknown as Prisma.TransactionClient); });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Share', urn: `share-4276-${n}.example` }, select: { id: true, urn: true } });
  const admin = await db.user.create({ data: { githubId: 42_760_000 + (n % 100_000), githubUsername: `share-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team' }, { db, userId: admin.id, roles: ['READER'] } as Context)).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a` }, select: { id: true } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'B', urn: `${org.urn}:b` }, select: { id: true } });
  const worker = async (appId: string, name: string) => {
    const id = generateId();
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId, agentId, name, slug: name.toLowerCase() } });
    await db.session.create({ data: { id: generateId(), appId, workerId: id, userId: admin.id, startedAt: new Date(now.getTime() - 3_600_000), updatedAt: new Date(now.getTime() - 60_000) } });
    return id;
  };
  kit = await worker(app.id, 'Kit');
  zed = await worker(other.id, 'Zed');
});

describe('#4276: withSharedWorkerActivity shares one fold only inside its boundaries', () => {
  it('the share itself: reads of this App\'s workers at the pass\'s instant run no fold of their own', async () => {
    await inTx((tx) => withSharedWorkerActivity(tx, app.id, now, async () => {
      await read(tx, [kit]);
      await loadAppWorkerActivity({ db: tx } as unknown as Context, app.id, { now });
    }));
    expect(folds).toBe(1);
  });

  it('1. a read at a different instant runs its own fold, and answers at its own instant', async () => {
    await inTx((tx) => withSharedWorkerActivity(tx, app.id, now, async () => {
      await read(tx, [kit], later);
      await loadAppWorkerActivity({ db: tx } as unknown as Context, app.id, { now: later });
    }));
    expect(folds, 'a read at another instant was answered from the share').toBe(3);
  });

  it('2. a read that names a worker of another App runs its own fold, and that worker is answered', async () => {
    const got = await inTx((tx) => withSharedWorkerActivity(tx, app.id, now, () => read(tx, [kit, zed])));
    expect(folds, 'a read naming another App\'s worker was answered from the share').toBe(2);
    expect(got.has(zed), 'the other App\'s worker was dropped').toBe(true);
  });

  it('3. on the shared client (not a transaction) no share is set: every read runs its own fold', async () => {
    folds = 0;
    await withSharedWorkerActivity(traced as never, app.id, now, async () => {
      await read(traced, [kit]);
      await read(traced, [kit]);
    });
    expect(folds, 'a share was set on the client every request uses').toBe(2);
  });

  it('4. after the read rejects, the share is gone: the next read on the same transaction runs its own fold', async () => {
    await inTx(async (tx) => {
      await expect(withSharedWorkerActivity(tx, app.id, now, async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
      // #4273: the abandoned share's own fold now starts after its JIT-off setting statement, so let it land first; the pin
      // is on the NEXT read's fold, not on when the discarded one is dispatched. #4285 (Arianna New-5): wait for that one
      // fold to be counted (inTx zeroed the count), not a fixed 100 ms a slow runner can outlast.
      for (let i = 0; i < 200 && folds < 1; i++) await new Promise((r) => setTimeout(r, 10));
      expect(folds, 'the abandoned share dispatched its one fold').toBe(1);
      const before = folds;
      await read(tx, [kit]);
      expect(folds - before, 'a rejected read left its share on the transaction').toBe(1);
    });
  });

  it('5. a nested call on the same transaction keeps the outer share, before and after it', async () => {
    await inTx((tx) => withSharedWorkerActivity(tx, app.id, now, async () => {
      await withSharedWorkerActivity(tx, app.id, now, () => read(tx, [kit]));
      await read(tx, [kit]);
    }));
    expect(folds, 'a nested call replaced or removed the outer share').toBe(1);
  });
});
