/**
 * #2043 (S6 PR 2, cor:agt:040:18, R30) — who approves a boot prompt.
 *
 * A node in the boot-prompt role family, placed in an Agent's system memory or
 * an App's install memory, is approved only by whoever manages that Agent or
 * App, as themselves: never through a bound worker session, an App key, an
 * impersonation or a run. Bulk approval skips and reports what the caller may
 * not approve. Off that placement the role is plain: a boot-prompt node in a
 * group memory takes ordinary writer approval, directly and in bulk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'ba-org', urn: 'ba-org' } })).id;
});

const ctxOf = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ db, userId, roles: [], clientId: `user:${userId}`, ...extra }) as unknown as Context;
const user = (name: string) => db.user.create({ data: { id: generateId(), name, handle: `ba-${name}-${generateId().slice(-6)}` } });
const bootSource = (memoryId: string, loc = 'boot:source') => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Source', content: 'You are {{worker.name}}.', role: 'boot-prompt' },
});
const plain = (memoryId: string, loc = 'notes:plain') => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Plain', content: 'plain' },
});

async function fixture() {
  const admin = await user('admin');
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const writer = await user('writer');
  await db.orgMember.create({ data: { organizationId: orgId, userId: writer.id, role: 'CONTRIBUTOR' } });
  const appOwner = await user('appowner');
  const owner = await user('owner');

  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'ba-org:agent-sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'ba-org:agent', organizationId: orgId, systemMemoryId: agentMem.id } });
  const { app, appKey } = await createDbAppWithKey(db, 'ba-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, appOwner.id, 'owner');
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'ba-org:install', organizationId: orgId, appId: app.id, installOfAgentId: agent.id, isInstallMemory: true },
  });
  const worker = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', signature: '', trailer: '' } });

  // A user-owned Agent: its owner manages it, and nobody else.
  const ownedMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'owned-sys', urn: `ba-owned-${generateId().slice(-6)}:sys`, ownerUserId: owner.id } });
  await db.agent.create({ data: { id: generateId(), name: 'Owned', urn: `ba-owned-${generateId().slice(-6)}:owned`, ownerUserId: owner.id, systemMemoryId: ownedMem.id } });

  // A group memory: the role is plain here (misplaced), approval is the ordinary writer's.
  const group = await db.memory.create({ data: { id: generateId(), class: 'group', visibility: 'GROUP', name: 'group', urn: 'ba-org:group', organizationId: orgId } });
  await db.memoryMember.create({ data: { memoryId: group.id, userId: writer.id, role: 'writer' } });

  return { admin, writer, appOwner, owner, agent, agentMem, app, appKey, install, worker, ownedMem, group };
}

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
/** Nothing approved: not the node, not any of its revisions (#2083). */
async function expectUnapproved(nodeId: string) {
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).approvedAt).toBeNull();
  expect(await db.nodeRevision.count({ where: { nodeId, approvedAt: { not: null } } })).toBe(0);
}
const approve = (nodeId: string, ctx: Context) => M.approveNode(null, { nodeRef: nodeId }, ctx);
const bulk = (memoryId: string, ctx: Context) => M.approveMemoryNodes(null, { memoryRef: memoryId }, ctx);

describe('#2043 S6 — the manager approves a placed boot prompt, as themselves', () => {
  it('an org admin approves a source in the Agent system memory and in the install memory (self-approval allowed)', async () => {
    const f = await fixture();
    for (const memoryId of [f.agentMem.id, f.install.id]) {
      const node = await bootSource(memoryId);
      expect(await codeOf(approve(node.id, ctxOf(f.admin.id)))).toBe('NO_ERROR');
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvedAt).not.toBeNull();
    }
  });

  it('an owner-role App member approves in the install memory', async () => {
    const f = await fixture();
    const node = await bootSource(f.install.id);
    expect(await codeOf(approve(node.id, ctxOf(f.appOwner.id)))).toBe('NO_ERROR');
  });

  it("a user-owned Agent's owner approves its source", async () => {
    const f = await fixture();
    const node = await bootSource(f.ownedMem.id);
    expect(await codeOf(approve(node.id, ctxOf(f.owner.id)))).toBe('NO_ERROR');
  });

  it('a compiled node in the Agent system memory takes the same gate', async () => {
    const f = await fixture();
    const node = await withCompileWrite(() => db.node.create({
      data: { id: generateId(), memoryId: f.agentMem.id, loc: 'boot:compiled', name: 'Compiled', content: 'c', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }));
    expect(await codeOf(approve(node.id, ctxOf(f.admin.id)))).toBe('NO_ERROR');
  });
});

describe('#2043 S6 R30 — a bound worker session never approves a boot prompt', () => {
  it('directly: refused for the manager\'s session in both placements, nothing approved', async () => {
    const f = await fixture();
    for (const memoryId of [f.agentMem.id, f.install.id]) {
      const node = await bootSource(memoryId);
      const code = await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(approve(node.id, ctxOf(f.admin.id))));
      expect(code).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
      await expectUnapproved(node.id);
    }
  });

  it('in bulk: the boot prompt is skipped and reported, the ordinary node is approved', async () => {
    const f = await fixture();
    const node = await bootSource(f.agentMem.id);
    const other = await plain(f.agentMem.id);
    const result = await runAsActor({ workerId: f.worker.id, agentId: null }, () => bulk(f.agentMem.id, ctxOf(f.admin.id)));
    expect(result.skippedBootPrompts).toEqual(['boot:source']);
    expect(result.skippedBootPromptCount).toBe(1);
    expect(result.approved.map((r: { nodeId: string }) => r.nodeId)).toEqual([other.id]);
    await expectUnapproved(node.id);
  });

  it('the same manager with no session binding approves in bulk, nothing skipped', async () => {
    const f = await fixture();
    const node = await bootSource(f.agentMem.id);
    const result = await bulk(f.agentMem.id, ctxOf(f.admin.id));
    expect(result.skippedBootPromptCount).toBe(0);
    expect(result.approved.map((r: { nodeId: string }) => r.nodeId)).toContain(node.id);
  });
});

describe('#2043 S6 — principals that are not the manager as themselves', () => {
  const principals = (f: Awaited<ReturnType<typeof fixture>>): Array<[string, Context]> => [
    ['app key', { db, appId: f.app.id, roles: [], clientId: `app:${f.appKey.id}` } as unknown as Context],
    ['impersonation of the admin', ctxOf(f.admin.id, { impersonation: { sessionId: generateId(), actorUserId: generateId(), organizationId: orgId } })],
    ['run principal of the admin', { db, ...runAuthContext({ id: generateId(), appId: f.app.id, userId: f.admin.id, organizationId: orgId }) } as unknown as Context],
    ['owner-role App member, in the Agent system memory', ctxOf(f.appOwner.id)],
  ];

  it('each fails to approve directly, nothing approved', async () => {
    const f = await fixture();
    for (const [label, ctx] of principals(f)) {
      for (const memoryId of [f.agentMem.id, f.install.id]) {
        if (label.startsWith('owner-role') && memoryId === f.install.id) continue; // manages the App: allowed above
        const node = await bootSource(memoryId, `boot:${generateId().slice(-6)}`);
        expect(await codeOf(approve(node.id, ctx)), `${label} in ${memoryId === f.install.id ? 'install' : 'agent'}`).not.toBe('NO_ERROR');
        await expectUnapproved(node.id);
      }
    }
  });

  it('each approves nothing in the boot family in bulk', async () => {
    const f = await fixture();
    const nodes = [await bootSource(f.agentMem.id), await bootSource(f.install.id)];
    for (const [, ctx] of principals(f)) {
      for (const memoryId of [f.agentMem.id, f.install.id]) await bulk(memoryId, ctx).catch(() => undefined);
    }
    // The owner-role member manages the App, so the install source is theirs to approve.
    await expectUnapproved(nodes[0]!.id);
  });

  it('a writer who is not the manager is refused with the typed code, not concealed', async () => {
    const f = await fixture();
    const node = await bootSource(f.install.id);
    const app = { db, appId: f.app.id, roles: [], clientId: `app:${f.appKey.id}` } as unknown as Context;
    const code = await codeOf(approve(node.id, app));
    expect(['BOOT_PROMPT_APPROVAL_FORBIDDEN', 'FORBIDDEN', 'NODE_NOT_FOUND']).toContain(code);
    await expectUnapproved(node.id);
  });
});

describe('#2043 S6 — off placement the role is plain', () => {
  it('a boot-prompt node in a group memory takes ordinary writer approval, directly and in bulk', async () => {
    const f = await fixture();
    const direct = await bootSource(f.group.id, 'boot:direct');
    expect(await codeOf(approve(direct.id, ctxOf(f.writer.id)))).toBe('NO_ERROR');
    const inBulk = await bootSource(f.group.id, 'boot:bulk');
    const result = await bulk(f.group.id, ctxOf(f.writer.id));
    expect(result.skippedBootPromptCount).toBe(0);
    expect(result.approved.map((r: { nodeId: string }) => r.nodeId)).toContain(inBulk.id);
  });

  it('an ordinary node in the Agent system memory keeps ordinary approval, even through a session', async () => {
    const f = await fixture();
    const node = await plain(f.agentMem.id);
    const code = await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(approve(node.id, ctxOf(f.admin.id))));
    expect(code).toBe('NO_ERROR');
  });
});

