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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { bootPromptApprovalGate } from '../../../lib/bootPromptApproval.js';
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

// Today no principal but the manager can WRITE a placed memory, so the write
// gate refuses the others before the manager gate is reached. The manager gate
// is the authority that holds if that ever changes: pin its own decision.
describe('#2043 S6 — the gate decides on its own, whatever the write gate admits', () => {
  it('names the manager as themselves, and refuses every other principal, in both placements', async () => {
    const f = await fixture();
    const run = { db, ...runAuthContext({ id: generateId(), appId: f.app.id, userId: f.admin.id, organizationId: orgId }) };
    const imp = ctxOf(f.admin.id, { impersonation: { sessionId: generateId(), actorUserId: generateId(), organizationId: orgId } });
    const appKey = { db, appId: f.app.id, roles: [], clientId: `app:${f.appKey.id}` };
    const decide = async (ctx: object, memoryId: string) => bootPromptApprovalGate(ctx as never, memoryId);
    expect(await decide(ctxOf(f.admin.id), f.agentMem.id)).toEqual({ placed: true, refusal: null });
    expect(await decide(ctxOf(f.admin.id), f.install.id)).toEqual({ placed: true, refusal: null });
    expect(await decide(ctxOf(f.appOwner.id), f.install.id)).toEqual({ placed: true, refusal: null });
    expect(await decide(ctxOf(f.owner.id), f.ownedMem.id)).toEqual({ placed: true, refusal: null });
    for (const memoryId of [f.agentMem.id, f.install.id]) {
      for (const ctx of [run, imp, appKey, ctxOf(f.writer.id)]) {
        expect(await decide(ctx, memoryId)).toEqual({ placed: true, refusal: 'BOOT_PROMPT_APPROVAL_FORBIDDEN' });
      }
      expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => decide(ctxOf(f.admin.id), memoryId)))
        .toEqual({ placed: true, refusal: 'BOOT_PROMPT_WORKER_SESSION_REFUSED' });
    }
    expect(await decide(ctxOf(f.appOwner.id), f.agentMem.id)).toEqual({ placed: true, refusal: 'BOOT_PROMPT_APPROVAL_FORBIDDEN' });
    expect(await decide(ctxOf(f.admin.id), f.ownedMem.id)).toEqual({ placed: true, refusal: 'BOOT_PROMPT_APPROVAL_FORBIDDEN' });
    expect(await decide(ctxOf(f.writer.id), f.group.id)).toEqual({ placed: false });
  });
});

// §10 Rook P2-1: an approval made outside the gate must not survive the node's
// ENTRY into the placed boot-prompt state (the approval hash covers neither role
// nor memory). Ending clears the hash on the node and on its revision records.
describe('#2043 S6 — an outside approval ends when its node enters the placed state', () => {
  const ended = async (nodeId: string) => {
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).approvalHash).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId, approvalHash: { not: null } } })).toBe(0);
  };

  it('the migration carries prisma/boot-prompt-approval-invariants.sql verbatim', () => {
    const root = fileURLToPath(new URL('../../../../prisma/', import.meta.url));
    const guard = readFileSync(join(root, 'boot-prompt-approval-invariants.sql'), 'utf8');
    const migration = readFileSync(join(root, 'migrations/20261022010000_boot_prompt_approval_entry/migration.sql'), 'utf8');
    expect(migration.endsWith(guard)).toBe(true);
  });

  it('A: a session-approved plain node, flipped into the boot role by the manager, is no longer approved', async () => {
    const f = await fixture();
    const node = await plain(f.agentMem.id);
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(approve(node.id, ctxOf(f.admin.id))))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).not.toBeNull();
    await M.updateNode(null, { input: { id: node.id, role: 'boot-prompt' } }, ctxOf(f.admin.id));
    await ended(node.id);
  });

  it('B: a writer-approved boot-role node in a group memory, moved into the Agent memory, is no longer approved', async () => {
    const f = await fixture();
    const node = await bootSource(f.group.id, 'boot:moved');
    expect(await codeOf(approve(node.id, ctxOf(f.writer.id)))).toBe('NO_ERROR');
    await db.memoryMember.create({ data: { memoryId: f.group.id, userId: f.admin.id, role: 'owner' } });
    await M.moveNode(null, { sourceRef: node.id, targetMemoryRef: f.agentMem.id }, ctxOf(f.admin.id));
    const moved = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(moved.memoryId).toBe(f.agentMem.id);
    await ended(node.id);
  });

  it('A2: the same role flip in the install memory ends a session-made approval (the install placement arm)', async () => {
    const f = await fixture();
    const node = await plain(f.install.id);
    expect(await runAsActor({ workerId: f.worker.id, agentId: null }, () => codeOf(approve(node.id, ctxOf(f.admin.id))))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).not.toBeNull();
    await M.updateNode(null, { input: { id: node.id, role: 'boot-prompt' } }, ctxOf(f.admin.id));
    await ended(node.id);
  });

  it('C: an Agent attaching a memory that holds approved boot-role nodes ends those approvals', async () => {
    const f = await fixture();
    const loose = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'loose', urn: 'ba-org:loose', organizationId: orgId } });
    const node = await bootSource(loose.id);
    const other = await plain(loose.id);
    await approve(node.id, ctxOf(f.admin.id));
    await approve(other.id, ctxOf(f.admin.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).not.toBeNull();
    await db.agent.create({ data: { id: generateId(), name: 'Late', urn: 'ba-org:late', organizationId: orgId, systemMemoryId: loose.id } });
    await ended(node.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).approvalHash).not.toBeNull();
  });

  it('D: a memory becoming an install memory ends the approvals of the boot prompts already in it (no TS path today: SQL)', async () => {
    const f = await fixture();
    const { app: app2 } = await createDbAppWithKey(db, 'ba-app-2', orgId);
    await createDbAppAgent(db, app2.id, f.agent.id);
    const later = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'later', urn: 'ba-org:later', organizationId: orgId } });
    const node = await bootSource(later.id);
    const other = await plain(later.id);
    await approve(node.id, ctxOf(f.admin.id));
    await approve(other.id, ctxOf(f.admin.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).not.toBeNull();
    await db.$executeRaw`UPDATE memories SET is_install_memory = true, app_id = ${app2.id}, install_of_agent_id = ${f.agent.id} WHERE id = ${later.id}`;
    await ended(node.id);
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).approvalHash).not.toBeNull();
  });

  it("the manager's own approval of a node already placed is kept, and so is the plain role's elsewhere", async () => {
    const f = await fixture();
    const placed = await bootSource(f.agentMem.id);
    await approve(placed.id, ctxOf(f.admin.id));
    await M.updateNode(null, { input: { id: placed.id, name: 'Renamed' } }, ctxOf(f.admin.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: placed.id } })).approvalHash).not.toBeNull();
    const group = await bootSource(f.group.id, 'boot:stays');
    await approve(group.id, ctxOf(f.writer.id));
    expect((await db.node.findUniqueOrThrow({ where: { id: group.id } })).approvalHash).not.toBeNull();
  });
});

// §10 / BLIND Dara P2-1: an install-memory approval takes the install's App/Agent
// authority in its OPENING ordered anchor set, before the memory/org anchors, as
// the revokers (uninstall) do; otherwise the two orders can cycle.
describe('#2043 S6 — install approval takes the install authority first', () => {
  it('parks on the Agent anchor an uninstall holds, before taking the memory anchor, then completes', async () => {
    const f = await fixture();
    const node = await bootSource(f.install.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: f.agent.id }], 'exclusive');
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const approval = codeOf(approve(node.id, ctxOf(f.admin.id)));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      const free = await db.$transaction(async (tx) => (await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('authorization:memory'), hashtext(${f.install.id})) AS ok`)[0]!.ok);
      expect(free).toBe(true);
    } finally {
      release();
      await holder;
    }
    expect(await approval).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).not.toBeNull();
  });
});

describe('#2043 S6 — a refusal changes nothing, and the fenced recheck decides', () => {
  // §10 Rook P3-1: the gate runs on the locked row BEFORE the revision reconcile,
  // which would otherwise write a revision for a node whose text drifted.
  it('a skipped boot prompt with drifted revision state gets no reconcile revision', async () => {
    const f = await fixture();
    const node = await bootSource(f.agentMem.id);
    await db.$executeRaw`UPDATE nodes SET content = 'drifted outside the writer' WHERE id = ${node.id}`;
    const before = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    const revisions = await db.nodeRevision.count({ where: { nodeId: node.id } });
    const result = await runAsActor({ workerId: f.worker.id, agentId: null }, () => bulk(f.agentMem.id, ctxOf(f.admin.id)));
    expect(result.skippedBootPrompts).toEqual(['boot:source']);
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect({ revSeq: after.revSeq, contentRevSeq: after.contentRevSeq }).toEqual({ revSeq: before.revSeq, contentRevSeq: before.contentRevSeq });
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(revisions);
  });

  // §10 Rook P3-2: the pooled pre-flight is only a pre-flight; the write gate is
  // re-decided inside the fenced transaction, after the anchors are held.
  it('a manager demoted while the approval waits on the org anchor is refused inside the transaction', async () => {
    const f = await fixture();
    const node = await plain(f.agentMem.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const demote = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive');
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: f.admin.id } }, data: { role: 'READER' } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const approval = codeOf(approve(node.id, ctxOf(f.admin.id)));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await demote;
    }
    expect(await approval).toBe('FORBIDDEN');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).toBeNull();
  });
});

// §10 Rook P3-4 / carried P3-2: the bulk door mirrors the direct door.
describe('#2043 S6 — the bulk door takes install authority first and rechecks in the transaction', () => {
  it('bulk parks on the Agent anchor before the memory anchor, then completes', async () => {
    const f = await fixture();
    const node = await bootSource(f.install.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: f.agent.id }], 'exclusive');
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const result = bulk(f.install.id, ctxOf(f.admin.id));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      const free = await db.$transaction(async (tx) => (await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('authorization:memory'), hashtext(${f.install.id})) AS ok`)[0]!.ok);
      expect(free).toBe(true);
    } finally {
      release();
      await holder;
    }
    expect((await result).approved.map((r: { nodeId: string }) => r.nodeId)).toContain(node.id);
  });

  it('a manager demoted while bulk waits on the org anchor is refused inside the transaction', async () => {
    const f = await fixture();
    const node = await plain(f.agentMem.id);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const demote = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: orgId }], 'exclusive');
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: f.admin.id } }, data: { role: 'READER' } });
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    const result = codeOf(bulk(f.agentMem.id, ctxOf(f.admin.id)));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      release();
      await demote;
    }
    expect(await result).toBe('FORBIDDEN');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).approvalHash).toBeNull();
  });
});

