/**
 * #2046 S9-3 — every writer of compile-relevant authority enters the #2063 include-history fence FIRST.
 *
 * The boot-prompt compile takes the fence, then the authority anchors, then the base-graph lock. A
 * writer that took its anchors or rows before the fence would deadlock with it, or let a compile read
 * authority half-changed. Each boundary below is pinned the same way: another connection holds the
 * fence; the writer must BLOCK on it (its effect not yet visible) while holding no other advisory lock
 * (so the fence came before the anchors); releasing the fence lets it complete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctxOf = (userId: string) => ({ db, userId, roles: [], clientId: `user:${userId}` }) as unknown as Context;
const user = (name: string) => db.user.create({ data: { id: generateId(), name } });

/** Hold the fence on one connection while `run` starts; assert it blocks first, then completes on release. */
async function expectFenceFirst(run: () => Promise<unknown>, effectVisible: () => Promise<boolean>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await held; });
  await inside;
  let settled = false;
  const writer = run().then(() => { settled = true; }, (e) => { settled = true; throw e; });
  writer.catch(() => {});
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 3_000);
    // Only the holder's fence is granted: the waiter took no anchor or graph lock before it.
    const granted = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database() AND a.pid <> pg_backend_pid()`;
    expect(granted[0].n).toBe(1);
    expect(settled).toBe(false);
    expect(await effectVisible()).toBe(false);
  } finally {
    release();
    await holder;
  }
  await writer;
  expect(await effectVisible()).toBe(true);
}

let orgId: string;
let vendorId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'wf-org', urn: 'wf-org' } })).id;
  vendorId = (await db.organization.create({ data: { id: generateId(), name: 'wf-vendor', urn: 'wf-vendor' } })).id;
});

async function admin() {
  const a = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: a.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: vendorId, userId: a.id, role: 'ADMIN' } });
  return a;
}
const orgAgent = (slug: string, organizationId = orgId, visibility: 'PUBLIC' | 'ORGANIZATION' = 'ORGANIZATION') =>
  db.agent.create({ data: { id: generateId(), name: slug, urn: `${organizationId === orgId ? 'wf-org' : 'wf-vendor'}:${slug}`, organizationId, visibility } });

describe('#2046 S9-3 grant, subscription, base and retirement writers enter the fence first', () => {
  it('createAgentOrgGrant', async () => {
    const a = await admin();
    const agent = await orgAgent('pub', vendorId, 'PUBLIC');
    const present = async () => (await db.agentOrgGrant.count({ where: { orgId, agentId: agent.id } })) === 1;
    await expectFenceFirst(() => M.createAgentOrgGrant({}, { agentRef: agent.id, orgRef: orgId }, ctxOf(a.id)), present);
  });

  it('revokeAgentOrgGrant', async () => {
    const a = await admin();
    const agent = await orgAgent('pub', vendorId, 'PUBLIC');
    await db.agentOrgGrant.create({ data: { orgId, agentId: agent.id, activatedAt: new Date() } });
    const revoked = async () => (await db.agentOrgGrant.findUniqueOrThrow({ where: { orgId_agentId: { orgId, agentId: agent.id } } })).revokedAt !== null;
    await expectFenceFirst(() => M.revokeAgentOrgGrant({}, { agentRef: agent.id, orgRef: orgId }, ctxOf(a.id)), revoked);
  });

  it('revokeAgentSubscription', async () => {
    const a = await admin();
    const sub = await user('sub');
    const agent = await orgAgent('prod');
    await db.agentSubscription.create({ data: { userId: sub.id, agentId: agent.id, activatedAt: new Date() } });
    const revoked = async () => (await db.agentSubscription.findUniqueOrThrow({ where: { userId_agentId: { userId: sub.id, agentId: agent.id } } })).revokedAt !== null;
    await expectFenceFirst(() => M.revokeAgentSubscription({}, { agentId: agent.id, userId: sub.id }, ctxOf(a.id)), revoked);
  });

  it('setAgentBase', async () => {
    const a = await admin();
    const base = await orgAgent('base');
    const child = await orgAgent('child');
    const set = async () => (await db.agent.findUniqueOrThrow({ where: { id: child.id } })).extendsAgentId === base.id;
    await expectFenceFirst(() => M.setAgentBase({}, { ref: child.id, baseRef: base.id }, ctxOf(a.id)), set);
  });

  it('deleteAgent (retirement)', async () => {
    const a = await admin();
    const agent = await orgAgent('gone');
    const gone = async () => (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt !== null;
    await expectFenceFirst(() => M.deleteAgent({}, { ref: agent.id }, ctxOf(a.id)), gone);
  });
});

describe('#2046 S9-3 worker retirement and the S8 pointer writers enter the fence first', () => {
  async function fixture() {
    const a = await admin();
    const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'wf-org:agent-sys', organizationId: orgId } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'wf-org:agent', organizationId: orgId, systemMemoryId: agentMem.id } });
    const { app } = await createDbAppWithKey(db, 'wf-app', orgId);
    await createDbAppAgent(db, app.id, agent.id);
    const install = await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'install', urn: 'wf-org:install', organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
    });
    const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });
    const compiledIn = (memoryId: string) => withCompileWrite(() => db.node.create({
      data: { id: generateId(), memoryId, loc: 'boot:compiled', name: 'Compiled', content: 'c', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }));
    return { a, agent, app, worker, agentNode: await compiledIn(agentMem.id), installNode: await compiledIn(install.id) };
  }

  it('retireWorker', async () => {
    const f = await fixture();
    const retired = async () => (await db.worker.findUniqueOrThrow({ where: { id: f.worker.id } })).retiredAt !== null;
    await expectFenceFirst(() => M.retireWorker({}, { workerRef: f.worker.id }, ctxOf(f.a.id)), retired);
  });

  it('setAgentBootPrompt', async () => {
    const f = await fixture();
    const set = async () => (await db.agent.findUniqueOrThrow({ where: { id: f.agent.id } })).bootPromptNodeId === f.agentNode.id;
    await expectFenceFirst(() => M.setAgentBootPrompt({}, { agentRef: f.agent.id, nodeRef: f.agentNode.id }, ctxOf(f.a.id)), set);
  });

  it('setAppAgentBootPrompt', async () => {
    const f = await fixture();
    const set = async () => (await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: f.app.id, agentId: f.agent.id } } })).bootPromptNodeId === f.installNode.id;
    await expectFenceFirst(() => M.setAppAgentBootPrompt({}, { appRef: f.app.id, agentRef: f.agent.id, nodeRef: f.installNode.id }, ctxOf(f.a.id)), set);
  });

  it('setWorkerBootPrompt', async () => {
    const f = await fixture();
    const set = async () => (await db.worker.findUniqueOrThrow({ where: { id: f.worker.id } })).bootPromptNodeId === f.installNode.id;
    await expectFenceFirst(() => M.setWorkerBootPrompt({}, { workerRef: f.worker.id, nodeRef: f.installNode.id }, ctxOf(f.a.id)), set);
  });
});
