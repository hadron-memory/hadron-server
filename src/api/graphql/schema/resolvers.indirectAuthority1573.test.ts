/**
 * #1573: indirect authority writes join #1572's authority-anchor protocol.
 *
 * - Membership capacity: `installation_policy.maxMembers` was count-then-act,
 *   so two concurrent adds through different doors (`joinApp`, the GraphQL
 *   `ensureAppMember`) could both see a free seat. Both doors now take one
 *   exclusive per-App capacity lock through the count and the insert.
 * - `revokeAgentSubscription` holds `[agent, target user]` EXCLUSIVE, the
 *   anchors the subscription writers hold shared, so a revocation cannot
 *   return while a new subscription for the pair is still about to commit.
 *
 * Races are staged deterministically: a third connection holds the contested
 * lock, and the `pg_locks` barrier (scoped per #1470) proves each racer is
 * actually waiting on it before the lock is released.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let agent: { id: string };
let app: { id: string };

const ctxFor = (userId: string, roles: string[] = ['READER']): Context =>
  ({ db, userId, roles }) as unknown as Context;

async function mkUser(n: number, roles: string[] = ['READER']) {
  return db.user.create({ data: { githubId: 157300 + n, githubUsername: `u1573-${n}`, roles: roles as never } });
}

/** Hold an advisory lock on a separate connection until `release` is called. */
async function hold(lock: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held!: () => void;
  const isHeld = new Promise<void>((r) => { held = r; });
  const done = db.$transaction(async (tx) => {
    await lock(tx);
    held();
    await gate;
  }, { timeout: 20_000 });
  await isHeld;
  return { release, done };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'o1573', urn: 'o1573.example' } });
  admin = await mkUser(1, ['ADMIN']);
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: {
    id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'agent',
    installationPolicy: { maxMembers: 1, memberRoles: ['member'] } as never,
  } });
  app = await db.app.create({ data: {
    id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app',
    appAgents: { create: { agentId: agent.id } },
  } });
});

describe('#1573: membership capacity is serialized across both doors', () => {
  it('joinApp and the GraphQL ensureAppMember both queue on the capacity lock; exactly one takes the last seat', async () => {
    const joiner = await mkUser(2);
    const invited = await mkUser(3);
    const holder = await hold((tx) =>
      tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('app-capacity'), hashtext(${app.id}))`);

    const viaJoin = M.joinApp(null, { appId: app.id }, ctxFor(joiner.id));
    const viaEnsure = M.ensureAppMember(null, { appId: app.id, userId: invited.id, role: 'member' }, ctxFor(admin.id, ['ADMIN']));
    // Both doors are blocked on the SAME capacity key: proof they participate.
    await waitForLockWaitersOfType(db, 'advisory', 2);
    holder.release();
    await holder.done;

    const outcomes = await Promise.allSettled([viaJoin, viaEnsure]);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/membership is full/);
    expect(await db.appMember.count({ where: { appId: app.id } })).toBe(1);
  });

  it('CONTROL: an unlimited App takes no capacity lock and admits both', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { installationPolicy: { maxMembers: 'unlimited', memberRoles: ['member'] } as never } });
    const a = await mkUser(4);
    const b = await mkUser(5);
    await M.joinApp(null, { appId: app.id }, ctxFor(a.id));
    await M.joinApp(null, { appId: app.id }, ctxFor(b.id));
    expect(await db.appMember.count({ where: { appId: app.id } })).toBe(2);
  });

  it('joinApp keeps its typed lifecycle errors for an uninstalled App', async () => {
    const joiner = await mkUser(6);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expect(M.joinApp(null, { appId: app.id }, ctxFor(joiner.id)))
      .rejects.toMatchObject({ extensions: { code: 'AppUninstalledError' } });
  });
});

describe('#1573: revokeAgentSubscription is an exclusive revoker on [agent, target user]', () => {
  it('waits for an in-flight subscription writer holding the pair shared, then revokes what it wrote', async () => {
    const target = await mkUser(7);
    // An in-flight writer: holds [agent, target] shared and inserts the
    // subscription, uncommitted, the way the anchored subscription writers do.
    const writer = await hold(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: agent.id }, { kind: 'user', id: target.id }], 'shared');
      await tx.agentSubscription.create({ data: { userId: target.id, agentId: agent.id, activatedAt: new Date() } });
    });
    const revoke = M.revokeAgentSubscription(null, { agentId: agent.id, userId: target.id }, ctxFor(admin.id, ['ADMIN']));
    // The revoker is blocked on the writer's anchors, not racing past it.
    await waitForLockWaitersOfType(db, 'advisory', 1);
    writer.release();
    await writer.done;
    await revoke;
    const sub = await db.agentSubscription.findUniqueOrThrow({ where: { userId_agentId: { userId: target.id, agentId: agent.id } } });
    expect(sub.revokedAt).not.toBeNull();
  });
});
