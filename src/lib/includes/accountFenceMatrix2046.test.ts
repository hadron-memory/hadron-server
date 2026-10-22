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
import { cleanDb, createDbAppWithKey, createDbAgentSubscription, createDbAppAgent, createDbAppMember } from '../../test/helpers.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../bootPrompt.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withReconciledNodeRead } from './reconciledNodeRead.js';
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

/** Boot-prompt pointer setters: a compiled node in the agent's system memory (AGENT) or the install memory (APP_AGENT, WORKER). */
async function pointerFixture(): Promise<{ agentNode: string; installNode: string }> {
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'mx.org:sys', organizationId: org.id } });
  await db.agent.update({ where: { id: agentA.id }, data: { systemMemoryId: agentMem.id } });
  await createDbAppAgent(db, app.id, agentA.id);
  await createDbAppMember(db, app.id, admin.id, 'member');
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'mx.org:install', organizationId: org.id, appId: app.id, installOfAgentId: agentA.id, isInstallMemory: true },
  });
  const compiledIn = (memoryId: string) => withCompileWrite(() => db.node.create({
    data: { id: generateId(), memoryId, loc: 'boot:compiled', name: 'C', content: 'c', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
  }));
  return { agentNode: (await compiledIn(agentMem.id)).id, installNode: (await compiledIn(install.id)).id };
}
let nodes: { agentNode: string; installNode: string };
classes.push(
  {
    name: 'pointer AGENT (setAgentBootPrompt)',
    setup: async () => { nodes = await pointerFixture(); },
    run: () => M.setAgentBootPrompt(null, { agentRef: agentA.id, nodeRef: nodes.agentNode }, ctx(admin.id)),
    effect: async () => (await db.agent.findUniqueOrThrow({ where: { id: agentA.id } })).bootPromptNodeId === nodes.agentNode,
  },
  {
    name: 'pointer APP_AGENT (setAppAgentBootPrompt)',
    setup: async () => { nodes = await pointerFixture(); },
    run: () => M.setAppAgentBootPrompt(null, { appRef: app.id, agentRef: agentA.id, nodeRef: nodes.installNode }, ctx(admin.id)),
    effect: async () => (await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: app.id, agentId: agentA.id } } })).bootPromptNodeId === nodes.installNode,
  },
  {
    name: 'pointer WORKER (setWorkerBootPrompt)',
    setup: async () => { nodes = await pointerFixture(); },
    run: () => M.setWorkerBootPrompt(null, { workerRef: worker.id, nodeRef: nodes.installNode }, ctx(admin.id)),
    effect: async () => (await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).bootPromptNodeId === nodes.installNode,
  },
);
classes.push(
  {
    name: 'grant create (createAgentOrgGrant)',
    run: () => M.createAgentOrgGrant(null, { agentRef: pub.id, orgRef: other.id }, ctx(otherAdmin.id)),
    effect: async () => (await db.agentOrgGrant.count({ where: { agentId: pub.id, orgId: other.id, revokedAt: null } })) === 1,
  },
  {
    name: 'delete agent (deleteAgent)',
    run: () => M.deleteAgent(null, { ref: agentB.id }, ctx(admin.id)),
    effect: async () => (await db.agent.findUnique({ where: { id: agentB.id } }))?.deletedAt != null || (await db.agent.findUnique({ where: { id: agentB.id } })) === null,
  },
);
classes.push(
  {
    name: 'install (installAgentIntoApp)',
    run: () => M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentB.id }, ctx(admin.id)),
    effect: async () => (await db.appAgent.count({ where: { appId: app.id, agentId: agentB.id } })) === 1,
  },
  {
    name: 'uninstall (uninstallAgentFromApp)',
    setup: async () => { await M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentB.id }, ctx(admin.id)); },
    run: () => M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: agentB.id }, ctx(admin.id)),
    effect: async () => (await db.appAgent.count({ where: { appId: app.id, agentId: agentB.id } })) === 0,
  },
);
let driftNode: string;
classes.push({
  // The reconcile slow path of the node read: a node with no stored revision fingerprint is drift, so the read opens the
  // fence and reconciles (the helper behind Query.node and the MCP read, called directly here).
  name: 'reconcile read slow path (withReconciledNodeRead)',
  setup: async () => {
    const mem = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'k', urn: 'mx.org:k', organizationId: org.id } });
    driftNode = (await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'n', name: 'n', content: 'x' } })).id;
    await db.$executeRaw`UPDATE nodes SET revision_content_hash = NULL WHERE id = ${driftNode}`;
  },
  run: async () => {
    const memoryId = (await db.node.findUniqueOrThrow({ where: { id: driftNode } })).memoryId;
    return withReconciledNodeRead(db, driftNode, memoryId, async () => true, async () => 'ok');
  },
  effect: async () => (await db.$queryRaw<Array<{ h: string | null }>>`SELECT revision_content_hash AS h FROM nodes WHERE id = ${driftNode}`)[0].h != null,
});
let endpointNode: string;
classes.push({
  // The same slow path through the real endpoint: Query.node on a drifted node (no stored revision fingerprint) opens
  // the fence and reconciles, so it is a predecessor like any writer (the MCP node read shares the helper).
  name: 'reconcile read endpoint (Query.node)',
  setup: async () => {
    const mem = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'ke', urn: 'mx.org:ke', organizationId: org.id, visibility: 'ORGANIZATION' } });
    endpointNode = (await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'ne', name: 'ne', content: 'x' } })).id;
    await db.$executeRaw`UPDATE nodes SET revision_content_hash = NULL WHERE id = ${endpointNode}`;
  },
  run: async () => {
    const n = await (resolvers.Query as any).node(null, { ref: endpointNode }, ctx(admin.id));
    expect(n?.id).toBe(endpointNode);
    return n;
  },
  effect: async () => (await db.$queryRaw<Array<{ h: string | null }>>`SELECT revision_content_hash AS h FROM nodes WHERE id = ${endpointNode}`)[0].h != null,
});
let firstContactApp: string;
classes.push({
  // First contact: a new end-user with no subscription row, so the license write can create entitlement and the start
  // runs in the fence (a returning user runs unfenced and is pinned in resolvers.writerFences2046.test.ts).
  name: 'first contact (startAgentSession)',
  setup: async () => {
    const { app: a2 } = await createDbAppWithKey(db, 'fc-app', org.id);
    await createDbAppAgent(db, a2.id, agentA.id);
    await db.app.update({ where: { id: a2.id }, data: { createUserPermission: 'IMPLICIT' } });
    firstContactApp = a2.id;
  },
  run: () => M.startAgentSession({}, { agentId: agentA.id, externalUserId: 'ext-1' }, { db, appId: firstContactApp, roles: [] } as unknown as Context),
  effect: async () => (await db.agentSubscription.count({ where: { agentId: agentA.id } })) === 1,
});

describe.each(classes)('#2046 S9-3 stale-wait matrix: $name', (c) => {
  it('a committed real holder ahead of the account makes the account fail 40001 with no work; the holder took effect and bumped once', async () => {
    await c.setup?.();
    const before = await epoch();
    const { pred, acct } = await stage(c.run, accountOp(`stale-${c.name.replace(/\W/g, '')}`));
    await pred;
    expect(isSerializationConflict(await acct.then(() => null, (e) => e))).toBe(true);
    expect(await orgCount(`stale-${c.name.replace(/\W/g, '')}`)).toBe(0);
    expect(await c.effect()).toBe(true);
    expect(await epoch()).toBe(before + 1);
  });

  it('reverse order: the account holds the fence, the real holder waits, then completes', async () => {
    await c.setup?.();
    const before = await epoch();
    await reverse(c.run, `rev-${c.name.replace(/\W/g, '')}`);
    expect(await orgCount(`rev-${c.name.replace(/\W/g, '')}`)).toBe(1);
    expect(await c.effect()).toBe(true);
    expect(await epoch()).toBe(before + 2);
  });
});
