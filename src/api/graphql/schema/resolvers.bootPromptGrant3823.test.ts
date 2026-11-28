/**
 * #3823 (ruling 0267; cor:agt:040:11 r8, cor:acl:140:01/:04) — the boot-prompt EDIT grant: one edit, one source node, held by the
 * worker, an hour from activation, signed by a person who could make the edit.
 *
 * REVERSED IN PART BY #5453 Ask 5 (Holger, 2026-11-27, decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles, section 4b):
 * a worker session edits a source with NO grant, wherever its holder may write the memory, and through every door. No door asks
 * for the edit grant and none spends it. Every test below that pinned a refusal ("still BOOT_PROMPT_WORKER_SESSION_REFUSED") is
 * kept and restated to what now happens: the write is admitted (the holder here is an organisation ADMIN who manages the Agent
 * and the App, so may write both memories), and a grant in the picture is left UNSPENT. The library that reads and spends an
 * edit grant is still pinned directly at the end of the file; nothing in the server calls it.
 *
 * The refusals a session still gets for a memory its holder may not write, and for a compiled node, are pinned in
 * resolvers.bootPromptWorkerWrites5453.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasUsableEditGrant, isGrantableEdit, spendEditGrant } from '../../../lib/grants/bootPromptGrant.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const EDIT = 'bootprompt.source.edit';

let admin: { id: string };
let stranger: { id: string };
let orgId: string;
let appId: string;
let agentId: string;
let workerId: string;
let otherWorkerId: string;
let installMemoryId: string;
let agentMemoryId: string;
const asWorker = <T>(fn: () => Promise<T>, id = workerId) => runAsActor({ workerId: id, agentId: null }, fn);
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const src = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Source', content: 'original', role: 'boot-prompt' },
});
const world = () => ({ appId, userId: admin.id } as unknown as World);
/** An ACTIVE grant (the signature ceremony is a different slice; the row is built the way live3668 builds one). */
const grant = (nodeId: string, over: Record<string, unknown> = {}) => insertGrantUnguarded(world(), {
  user_id: null, worker_id: workerId, action: EDIT, action_values: { sourceNode: nodeId }, max_uses: 1,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id,
  expires_at: raw(`${DB_NOW} + interval '1 hour'`), ...over,
} as never);
const uses = (grantId: string) => db.grantEvent.count({ where: { grantId, action: 'USE' } });
const edit = (id: string, content = 'edited') => asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: id, content } }, ctx()));

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'G Org', urn: 'g3823.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 382301, githubUsername: 'g-admin', handle: 'g-admin', roles: [] } });
  stranger = await db.user.create({ data: { githubId: 382302, githubUsername: 'g-stranger', handle: 'g-stranger', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { id: generateId(), name: 'G App', urn: 'g3823.example:app', organizationId: org.id } });
  appId = app.id;
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'g3823.example:agent-sys', organizationId: orgId } });
  agentMemoryId = agentMem.id;
  const agent = await db.agent.create({ data: { id: generateId(), name: 'G agent', urn: 'g3823.example:agent', organizationId: org.id, systemMemoryId: agentMem.id } });
  agentId = agent.id;
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  installMemoryId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'g3823.example:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Otto', slug: 'otto' } })).id;
});

describe('the two grant actions are registered (#3823 acceptance 7)', () => {
  it('bootprompt.source.edit and bootprompt.compile.approve exist, SERVER-enforced, refusing a wildcard', async () => {
    const rows = await db.action.findMany({ where: { name: { in: [EDIT, 'bootprompt.compile.approve'] } }, orderBy: { name: 'asc' } });
    expect(rows.map((r) => r.name)).toEqual(['bootprompt.compile.approve', EDIT]);
    for (const r of rows) {
      expect(r.enforcement).toBe('SERVER');
      expect((r.parameters as Array<{ refusesWildcard: boolean }>).every((p) => p.refusesWildcard)).toBe(true);
    }
  });
});

describe('a worker edits its own source: no grant is needed and none is spent (#5453 Ask 5; was #3823 acceptance 1, 6)', () => {
  it('no grant: the edit is admitted (refused before #5453)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
    expect(await db.grant.count()).toBe(0);
  });

  it('own worker source, live grant naming it: the text changes, the revision records the worker, the grant is NOT spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
    const revs = await db.nodeRevision.findMany({ where: { nodeId: s.id }, orderBy: { id: 'asc' } });
    expect(revs.some((r) => r.editedByWorkerId === workerId)).toBe(true);
    expect(await uses(g)).toBe(0);
  });

  it('one grant, any number of edits: the second edit is admitted too', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    await edit(s.id, 'first');
    expect(await codeOf(edit(s.id, 'second'))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('second');
    expect(await uses(g)).toBe(0);
  });

  it('racing edits with one grant present: none is refused for the grant, and no USE is written', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const codes = await Promise.all([edit(s.id, 'a'), edit(s.id, 'b'), edit(s.id, 'c')].map(codeOf));
    expect(codes).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(codes.filter((c) => c === 'NO_ERROR').length).toBeGreaterThan(0);
    expect(await uses(g)).toBe(0);
  });

  it('the role Agent\'s own boot:source (system memory): admitted, with a grant or without', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    expect(await codeOf(edit(s.id, 'no grant'))).toBe('NO_ERROR');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('the App\'s boot:source in the install memory: admitted, with a grant or without', async () => {
    const s = await src(installMemoryId, 'boot:source');
    expect(await codeOf(edit(s.id, 'no grant'))).toBe('NO_ERROR');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });
});

describe('the grant is no longer the boundary: each of these was refused before #5453 and is now the memory gate\'s to decide', () => {
  it('a grant naming another node: this one is edited anyway, and the grant stays unspent', async () => {
    const mine = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const other = await src(installMemoryId, 'boot:source');
    const g = await grant(other.id);
    expect(await codeOf(edit(mine.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
  });

  it('another worker\'s source is edited by a session whose holder can write it ("Wider, for now")', async () => {
    const theirs = await src(installMemoryId, `boot:workers:${otherWorkerId}:source`);
    const g = await grant(theirs.id);
    expect(await codeOf(edit(theirs.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
  });

  it('a source in another Agent\'s system memory is edited where the holder manages that Agent', async () => {
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'g3823.example:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'g3823.example:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const s = await src(otherMem.id, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('a grant held by another worker changes nothing: the edit is admitted', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { worker_id: otherWorkerId });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('a grant an hour past activation changes nothing: the edit is admitted', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`), expires_at: raw(`${DB_NOW} + interval '1 day'`) });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('a pending, revoked or expired grant changes nothing: the edit is admitted', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: null, verification_kind: null, verified_by: null, issuer_user_id: null });
    await grant(s.id, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '10 minutes'`), expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('who signed a grant no longer matters: what matters is whether the session\'s HOLDER may write the memory', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    // The same session shape held by someone who may not write the install memory is refused, by the memory's own gate.
    const held = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'by a stranger\'s worker' } }, { db, userId: stranger.id, roles: [] })));
    expect(held).not.toBe('NO_ERROR');
    expect(held).not.toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
  });

  it('a wildcard or list value in a grant changes nothing: the edit is admitted', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { action_values: { sourceNode: '*' } });
    await grant(s.id, { action_values: { sourceNode: [s.id] } });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('no longer text in place only (was F1): a name, properties, tags or a description, with the text or without, is admitted and spends nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const inputs: Array<Record<string, unknown>> = [
      { name: 'changed name' }, { properties: { injected: true } }, { name: 'n', properties: { injected: true } },
      { content: 'new', name: 'renamed' }, { content: 'new', tags: ['x'] }, { content: 'newest', description: 'd' },
    ];
    for (const [i, extra] of inputs.entries()) {
      expect([i, await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, ...extra } }, ctx())))]).toEqual([i, 'NO_ERROR']);
    }
    expect(await uses(g)).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.content).toBe('newest');
    expect(row.name).toBe('renamed');
  });

  it('resending the same role and node type with the text is a text edit, as before', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id);
    expect(await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'same role', role: 'boot-prompt' } }, ctx())))).toBe('NO_ERROR');
  });

  it('no longer text in place only: a node-type change, a role strip, a move, a merge and a delete are admitted, and spend nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const t = await src(installMemoryId, 'boot:other');
    const u = await src(installMemoryId, 'boot:third');
    const g = await grant(s.id);
    const ops = [
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, nodeType: 'report' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: t.id, role: 'notes' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.moveNode(null, { sourceRef: s.id, targetUrn: 'hrn:node:g3823.example:install:elsewhere' }, ctx())),
      () => asWorker(() => resolvers.Mutation.mergeNodes(null, { input: { source: u.id, target: s.id } }, ctx())),
      () => asWorker(() => resolvers.Mutation.deleteNode(null, { nodeRef: s.id }, ctx())),
    ];
    for (const [i, op] of ops.entries()) expect([i, await codeOf(op())]).toEqual([i, 'NO_ERROR']);
    expect(await uses(g)).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.loc, row.nodeType, row.deletedAt === null]).toEqual(['elsewhere', 'report', false]);
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).role).toBe('notes');
  });

  it('a create of a boot-prompt source is admitted (refused before: a grant named an existing node)', async () => {
    const g = await grant(generateId());
    expect(await codeOf(asWorker(() => resolvers.Mutation.createNode(null, {
      input: { memoryRef: installMemoryId, loc: `boot:workers:${workerId}:source`, name: 'S', role: 'boot-prompt', content: 'x' },
    }, ctx())))).toBe('NO_ERROR');
    expect(await db.node.count({ where: { memoryId: installMemoryId, loc: `boot:workers:${workerId}:source`, deletedAt: null } })).toBe(1);
    expect(await uses(g)).toBe(0);
  });

  it('a compiled node is never written by a generic edit, grant or not (unchanged)', async () => {
    const c = await db.node.create({ data: { id: generateId(), memoryId: installMemoryId, loc: `boot:workers:${workerId}:compiled`, name: 'C', content: 'c', role: 'prompt.boot.compiled', nodeType: 'system' } });
    await grant(c.id);
    expect(await codeOf(edit(c.id))).toBe('BOOT_PROMPT_COMPILED_WRITE');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('c');
  });

  it('a person editing as themselves (no worker session) is unaffected, and spends no grant (unchanged)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    await resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'by the manager' } }, ctx());
    expect(await uses(g)).toBe(0);
  });

  it('a write refused for its own reason (a stale revision) is still refused, and the grant is untouched either way', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const stale = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'x', expectedRevSeq: 999 } as never }, ctx())));
    expect(stale).not.toBe('NO_ERROR');
    expect(stale).not.toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
  });
});

describe('over MCP (hadron_update_node): no grant, the memory\'s gate (#5453 Ask 5; was #3823)', () => {
  // An install memory is writable only through the GraphQL door (access-control.ts canWriteToMemory), so MCP reaches the role
  // Agent's own system-memory source.
  const mcpEdit = (urn: string, content = 'via mcp') => {
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    return asWorker(() => mcp.callToolText('hadron_update_node', { urn, content }).then((t) => String(t), (e: Error) => e.message));
  };
  it('admitted without a grant, and again with one, which stays unspent; the worker is recorded', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    const urn = 'hrn:node:g3823.example:agent-sys:boot:source';
    expect(await mcpEdit(urn, 'no grant')).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('no grant');
    const g = await grant(s.id);
    expect(await mcpEdit(urn)).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('via mcp');
    expect((await db.nodeRevision.findMany({ where: { nodeId: s.id } })).some((r) => r.editedByWorkerId === workerId)).toBe(true);
    expect(await mcpEdit(urn, 'again')).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('again');
  });
  it('over MCP a name or properties supplied with the text is admitted too (was F1), and spends nothing', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    const g = await grant(s.id);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const urn = 'hrn:node:g3823.example:agent-sys:boot:source';
    for (const extra of [{ name: 'renamed' }, { properties: { injected: true } }]) {
      const out = await asWorker(() => mcp.callToolText('hadron_update_node', { urn, content: 'x', ...extra }).then((t) => String(t), (e: Error) => e.message));
      expect(out).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    }
    expect(await uses(g)).toBe(0);
    expect(await db.node.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ content: 'x', name: 'renamed' });
  });
  it('another Agent\'s system-memory source is edited where the holder manages that Agent', async () => {
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'g3823.example:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'g3823.example:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const t = await src(otherMem.id, 'boot:source');
    const g = await grant(t.id);
    expect(await mcpEdit('hrn:node:g3823.example:other-sys:boot:source')).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: t.id } })).content).toBe('via mcp');
    expect(await uses(g)).toBe(0);
  });
});

describe('the library, called directly (no door calls it since #5453): spendEditGrant locks the grant row, THEN judges it (#3823)', () => {
  it('a revocation that commits while the spend waits for the lock is seen: nothing is spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const revoker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grants WHERE id = ${g} FOR UPDATE`;
      locked();
      await held;
      await tx.$executeRaw`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = ${admin.id} WHERE id = ${g}`;
    });
    await lockedP;
    const spender = db.$transaction((tx) => spendEditGrant(tx, workerId, { id: s.id, memoryId: installMemoryId, loc: s.loc }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await revoker;
    expect(await spender).toBe(false);
    expect(await uses(g)).toBe(0);
  });
});

describe('there is no lift any more, so no door is special (#5453 Ask 5; was #3823 Riana F1/F3, Andi P2-1)', () => {
  it('updateNodeProperties and updateNodeData reach a source too (was Riana F1: refused), and no grant is spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    expect(await codeOf(asWorker(() => resolvers.Mutation.updateNodeProperties(null, { nodeRef: s.id, properties: { injected: true } }, ctx())))).toBe('NO_ERROR');
    expect(await codeOf(asWorker(() => (resolvers.Mutation as any).updateNodeData(null, { nodeRef: s.id, data: { x: 1 } }, ctx())))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
  });

  it('importNode into an existing source writes it (was Riana F1: refused), and no grant is spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const out = await codeOf(asWorker(() => (resolvers.Mutation as any).importNode(null, {
      input: { memoryRef: installMemoryId, loc: s.loc, content: 'imported text', contentType: 'text/markdown' },
    }, ctx())));
    expect(out).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('imported text');
  });

  it('an edit grant minted with max_uses above 1 changes nothing: the edit is admitted and nothing is spent (was Andi P3)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id, { max_uses: 2 });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
  });

  it('Andi P2-1 (unchanged): updateNode names a node by ref OR by memory and loc, so a text edit that also names another loc or memory is refused by the door itself', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    for (const extra of [{ loc: `boot:workers:${workerId}:moved` }, { memoryRef: agentMemoryId }]) {
      const out = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'x', ...extra } as never }, ctx())));
      expect(out).not.toBe('NO_ERROR');
      expect(out).not.toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    }
    expect(await uses(g)).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.loc, row.memoryId, row.content]).toEqual([`boot:workers:${workerId}:source`, installMemoryId, 'original']);
  });

  it('a source in an install memory of ANOTHER App, or of the same App for ANOTHER Agent, is edited where the holder manages that App (was Riana F3: "not own")', async () => {
    const app2 = await db.app.create({ data: { id: generateId(), name: 'App2', urn: 'g3823.example:app2', organizationId: orgId } });
    await db.appAgent.create({ data: { appId: app2.id, agentId } });
    const other = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i2', urn: 'g3823.example:i2', organizationId: orgId, appId: app2.id, installOfAgentId: agentId, isInstallMemory: true } });
    const a2 = await db.agent.create({ data: { id: generateId(), name: 'A2', urn: 'g3823.example:a2', organizationId: orgId } });
    await db.appAgent.create({ data: { appId, agentId: a2.id } });
    const sameAppOtherAgent = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i3', urn: 'g3823.example:i3', organizationId: orgId, appId, installOfAgentId: a2.id, isInstallMemory: true } });
    for (const memoryId of [other.id, sameAppOtherAgent.id]) {
      const s = await src(memoryId, 'boot:source');
      const g = await grant(s.id);
      expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
      expect(await uses(g)).toBe(0);
    }
  });

  it('the Agent system-memory source: who signed a grant is no longer asked (was Riana F3, V54); the holder manages the Agent, so the edit is admitted', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    await db.appMember.create({ data: { appId, userId: stranger.id, role: 'owner' } });
    const g = await grant(s.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    // The App owner who does NOT manage the Agent holds a worker: its session writes the App's install-memory source
    // (the holder manages the App) and is refused the Agent's system-memory source (the holder does not manage the Agent).
    const asOwner = (id: string, content: string) => asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: id, content } }, { db, userId: stranger.id, roles: [] }));
    const t = await src(installMemoryId, `boot:workers:${workerId}:source`);
    expect(await codeOf(asOwner(t.id, 'by the app owner\'s worker'))).toBe('NO_ERROR');
    const refused = await codeOf(asOwner(s.id, 'by the app owner\'s worker'));
    expect(refused).not.toBe('NO_ERROR');
    expect(refused).not.toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
  });

  it('a signer who has since lost the App changes nothing (was the Andi gap): the edit is admitted on the holder\'s own access', async () => {
    const second = await db.user.create({ data: { githubId: 382303, githubUsername: 'g-second', handle: 'g-second', roles: [] } });
    const m = await db.orgMember.create({ data: { organizationId: orgId, userId: second.id, role: 'ADMIN' } });
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id, { verified_by: second.id, issuer_user_id: second.id });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: second.id } }, data: { role: 'CONTRIBUTOR' } }).catch(() => db.orgMember.delete({ where: { id: (m as any).id } } as never));
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    // What does matter: the HOLDER losing the App. A session held by the demoted person is refused by the memory's gate.
    const held = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { ref: s.id, content: 'by a demoted holder\'s worker' } }, { db, userId: second.id, roles: [] })));
    expect(held).not.toBe('NO_ERROR');
    expect(held).not.toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
  });
});

describe('the library, called directly (no door calls it since #5453): isGrantableEdit (each condition alone defeated the lift)', () => {
  const prior = { id: 'n1', memoryId: 'm1', loc: 'boot:source', role: 'boot-prompt', nodeType: 'info' };
  const ok = { otherFields: [] as string[], hasContent: true, door: true, memoryId: 'm1', loc: 'boot:source' };
  it('admits only the content-only, in-place, same-role, update-door shape', () => {
    expect(isGrantableEdit(prior, ok)).toBe(true);
    expect(isGrantableEdit(prior, { ...ok, door: false })).toBe(false);               // not the update door (Riana F1)
    expect(isGrantableEdit(prior, { ...ok, hasContent: false })).toBe(false);          // no text: a no-op must not spend the grant (Andi)
    expect(isGrantableEdit(prior, { ...ok, otherFields: ['name'] })).toBe(false);      // not only text (V46)
    expect(isGrantableEdit(prior, { ...ok, loc: 'boot:elsewhere' })).toBe(false);      // not in place (Andi P2-1)
    expect(isGrantableEdit(prior, { ...ok, memoryId: 'm2' })).toBe(false);
    expect(isGrantableEdit(prior, { ...ok, role: 'notes' })).toBe(false);
    expect(isGrantableEdit(prior, { ...ok, nodeType: 'task' })).toBe(false);
    expect(isGrantableEdit({ ...prior, role: 'prompt.boot.compiled' }, { ...ok, role: undefined })).toBe(false); // compiled, by role (#5453)
    expect(isGrantableEdit({ ...prior, role: 'prompt.boot.rule' }, { ...ok, role: undefined })).toBe(false);     // a rule is not a source
    expect(isGrantableEdit({ ...prior, role: 'notes' }, ok)).toBe(false);
    expect(isGrantableEdit(null, ok)).toBe(false);
  });
});

describe('the library, called directly (no door calls it since #5453): spendEditGrant re-judges the signer itself (Riana F6)', () => {
  it('a signer demoted after the pre-check but before the spend admits nothing and writes no USE', async () => {
    const second = await db.user.create({ data: { githubId: 382304, githubUsername: 'g-third', handle: 'g-third', roles: [] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: second.id, role: 'ADMIN' } });
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id, { verified_by: second.id, issuer_user_id: second.id });
    const facts = { id: s.id, memoryId: installMemoryId, loc: s.loc };
    expect(await db.$transaction((tx) => hasUsableEditGrant(tx, workerId, facts))).toBe(true);   // the pre-check passes
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: second.id }, data: { role: 'CONTRIBUTOR' } });
    expect(await db.$transaction((tx) => spendEditGrant(tx, workerId, facts))).toBe(false);       // the spend judges the signer again
    expect(await uses(g)).toBe(0);
  });
});

describe('no door asks for the edit grant or spends it (#5453 Ask 5; was "the MCP door judges the call\'s REAL arguments", Andi P2)', () => {
  it('neither node write door reads, lifts by or spends an edit grant, and the lift is not in the library either', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const door of ['../../../mcp/server.ts', './resolvers.mutation.node.ts']) {
      const text = read(door);
      for (const gone of ['bootPromptGrant', 'spendEditGrant', 'hasUsableEditGrant', 'isGrantableEdit', 'suppliedNonTextFields', 'assertBootPromptWriteAllowedOrGranted', 'BOOT_PROMPT_WORKER_SESSION_REFUSED']) {
        expect([door, gone, text.includes(gone)]).toEqual([door, gone, false]);
      }
    }
    const library = read('../../../lib/grants/bootPromptGrant.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const gone of ['assertBootPromptWriteAllowedOrGranted', 'spendEditGrantFor', 'BOOT_PROMPT_WORKER_SESSION_REFUSED', 'boundWorkerId']) {
      expect([gone, library.includes(gone)]).toEqual([gone, false]);
    }
  });
});
