/**
 * #2046 S9-3: the stale-wait matrix over the REAL fence holders. For each holder class, a REAL resolver is the
 * predecessor: it queues on the include-history fence ahead of an account transaction, commits, and the account's
 * epoch UPDATE must then fail 40001 before any work. The reverse order (the account holds the fence, the real holder
 * waits and then succeeds) is pinned per class too. The generic, prior-account and updateAgent cases live in
 * accountFence2046.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { cleanDb, createDbAgentSubscription } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { accountFenceClient, isSerializationConflict, withAccountFenceTransaction, withIncludeHistoryTransaction } from './includeHistoryFence.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const epoch = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT n FROM include_history_epoch WHERE id = 1`)[0].n);
const orgCount = (urn: string) => db.organization.count({ where: { urn } });

async function holdFence() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const done = withIncludeHistoryTransaction(db, async () => { entered(); await held; throw new Error('blocker rolls back'); });
  done.catch(() => {});
  await inside;
  return { release, done: done.then(() => undefined, () => undefined) };
}

const accountOp = (urn: string) => () => withAccountFenceTransaction(db, async (f) => {
  await accountFenceClient(f).organization.create({ data: { id: generateId(), name: urn, urn } });
});

async function stage(predecessor: () => Promise<unknown>, account: () => Promise<unknown>) {
  const x = await holdFence();
  const pred = predecessor();
  pred.catch(() => {});
  await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
  const acct = account();
  acct.catch(() => {});
  await waitForLockWaitersOfType(db, 'advisory', 2, 5_000);
  x.release();
  await x.done;
  return { pred, acct };
}

/** Reverse order: the account holds the fence, the real holder queues behind it, then runs to completion. */
async function reverse(holder: () => Promise<unknown>, urn: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const acct = withAccountFenceTransaction(db, async (f) => {
    await accountFenceClient(f).organization.create({ data: { id: generateId(), name: urn, urn } });
    entered();
    await held;
  });
  await inside;
  const h = holder();
  h.catch(() => {});
  await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
  release();
  await acct;
  await h;
}

let org: { id: string; urn: string };
let other: { id: string; urn: string };
let admin: { id: string };
let otherAdmin: { id: string };
let agentA: { id: string };
let agentB: { id: string };
let pub: { id: string };
let app: { id: string };
let worker: { id: string };
const ctx = (userId: string) => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` }) as unknown as Context;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'mx', urn: 'mx.org' } });
  other = await db.organization.create({ data: { id: generateId(), name: 'mx2', urn: 'mx2.org' } });
  admin = await db.user.create({ data: { id: generateId(), name: 'a', roles: ['READER'] } });
  otherAdmin = await db.user.create({ data: { id: generateId(), name: 'b', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: other.id, userId: otherAdmin.id, role: 'ADMIN' } });
  agentA = await db.agent.create({ data: { id: generateId(), name: 'a', urn: 'mx.org:a', organizationId: org.id, visibility: 'ORGANIZATION' } });
  agentB = await db.agent.create({ data: { id: generateId(), name: 'b', urn: 'mx.org:b', organizationId: org.id, visibility: 'ORGANIZATION' } });
  pub = await db.agent.create({ data: { id: generateId(), name: 'p', urn: 'mx.org:p', organizationId: org.id, visibility: 'PUBLIC' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'mx.org:team' } });
  worker = await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agentA.id, name: 'Ada', slug: 'ada' }, select: { id: true },
  });
});

/** One row per real holder class: the resolver call, and a check that its effect committed. */
const classes: Array<{ name: string; run: () => Promise<unknown>; effect: () => Promise<boolean>; setup?: () => Promise<void> }> = [
  {
    name: 'base (setAgentBase)',
    run: () => M.setAgentBase({}, { ref: agentA.id, baseRef: agentB.id }, ctx(admin.id)),
    effect: async () => (await db.agent.findUniqueOrThrow({ where: { id: agentA.id } })).extendsAgentId === agentB.id,
  },
  {
    name: 'retire (retireWorker)',
    run: () => M.retireWorker({}, { workerRef: worker.id }, ctx(admin.id)),
    effect: async () => (await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).retiredAt != null,
    setup: async () => { await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } }); },
  },
  {
    name: 'grant (revokeAgentOrgGrant)',
    run: () => M.revokeAgentOrgGrant(null, { agentRef: pub.id, orgRef: other.id }, ctx(otherAdmin.id)),
    effect: async () => (await db.agentOrgGrant.findFirstOrThrow({ where: { agentId: pub.id, orgId: other.id } })).revokedAt != null,
    setup: async () => {
      await db.agentOrgGrant.create({ data: { orgId: other.id, agentId: pub.id, activatedAt: new Date(), createdBy: otherAdmin.id } });
    },
  },
  {
    name: 'subscription (revokeAgentSubscription)',
    run: () => M.revokeAgentSubscription(null, { agentRef: pub.id, userRef: otherAdmin.id }, ctx(admin.id)),
    effect: async () => (await db.agentSubscription.findFirstOrThrow({ where: { agentId: pub.id, userId: otherAdmin.id } })).revokedAt != null,
    setup: async () => { await createDbAgentSubscription(db, otherAdmin.id, pub.id); },
  },
];

describe.each(classes)('#2046 S9-3 stale-wait matrix: $name', (c) => {
  it('a committed real holder ahead of the account makes the account fail 40001 with no work; the holder took effect and bumped once', async () => {
    await c.setup?.();
    const before = await epoch();
    const { pred, acct } = await stage(c.run, accountOp(`stale-${c.name.length}`));
    await pred;
    expect(isSerializationConflict(await acct.then(() => null, (e) => e))).toBe(true);
    expect(await orgCount(`stale-${c.name.length}`)).toBe(0);
    expect(await c.effect()).toBe(true);
    expect(await epoch()).toBe(before + 1);
  });

  it('reverse order: the account holds the fence, the real holder waits, then completes', async () => {
    await c.setup?.();
    const before = await epoch();
    await reverse(c.run, `rev-${c.name.length}`);
    expect(await orgCount(`rev-${c.name.length}`)).toBe(1);
    expect(await c.effect()).toBe(true);
    expect(await epoch()).toBe(before + 2);
  });
});
