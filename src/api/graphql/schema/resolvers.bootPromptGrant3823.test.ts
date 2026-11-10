/**
 * #3823 (ruling 0267; cor:agt:040:11 r8, cor:acl:140:01/:04) — a worker session edits the text of its OWN boot-prompt source
 * only under a grant: one edit, one source node, held by the worker, an hour from activation, signed by a person who could make
 * the edit. A holder's instruction alone never admits it. Everything else stays refused (V46).
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
const edit = (id: string, content = 'edited') => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id, content } }, ctx()));

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

describe('a worker edits its own source under a grant (#3823 acceptance 1, 6)', () => {
  it('no grant: still BOOT_PROMPT_WORKER_SESSION_REFUSED, and the holder\'s instruction alone changes nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });

  it('own worker source, live grant naming it: the text changes, the revision records the worker, the grant is spent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('edited');
    const revs = await db.nodeRevision.findMany({ where: { nodeId: s.id }, orderBy: { id: 'asc' } });
    expect(revs.some((r) => r.editedByWorkerId === workerId)).toBe(true);
    expect(await uses(g)).toBe(1);
  });

  it('one grant, one edit: the second edit is refused', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id);
    await edit(s.id, 'first');
    expect(await codeOf(edit(s.id, 'second'))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('first');
  });

  it('two racing edits on one grant: exactly one is admitted and one USE is written (lock, then judge)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const codes = await Promise.all([edit(s.id, 'a'), edit(s.id, 'b'), edit(s.id, 'c')].map(codeOf));
    expect(codes.filter((c) => c === 'NO_ERROR')).toHaveLength(1);
    expect(await uses(g)).toBe(1);
  });

  it('the role Agent\'s own boot:source (system memory) is in scope when the signer manages the Agent', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('the App\'s boot:source in the install memory is the role Agent\'s source for this App and is in scope', async () => {
    const s = await src(installMemoryId, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });
});

describe('the grant is the boundary (#3823 refusals that must hold)', () => {
  it('a grant naming another node does not admit this one', async () => {
    const mine = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const other = await src(installMemoryId, 'boot:source');
    const g = await grant(other.id);
    expect(await codeOf(edit(mine.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('another worker\'s source is refused even under a grant that names it (own check, holder who can write it)', async () => {
    const theirs = await src(installMemoryId, `boot:workers:${otherWorkerId}:source`);
    const g = await grant(theirs.id);
    expect(await codeOf(edit(theirs.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('a source in another Agent\'s system memory is refused even under a grant that names it', async () => {
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'g3823.example:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'g3823.example:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const s = await src(otherMem.id, 'boot:source');
    await grant(s.id);
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a grant held by another worker does not admit this one', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { worker_id: otherWorkerId });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a grant an hour past activation is refused, whatever its expires_at says', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`), expires_at: raw(`${DB_NOW} + interval '1 day'`) });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a pending, revoked or expired grant admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { activated_at: null, verification_kind: null, verified_by: null, issuer_user_id: null });
    await grant(s.id, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    await grant(s.id, { activated_at: raw(`${DB_NOW} - interval '10 minutes'`), expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a signer who cannot make the edit themselves (no manager of the App) admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a wildcard or list value names no single source and admits nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id, { action_values: { sourceNode: '*' } });
    await grant(s.id, { action_values: { sourceNode: [s.id] } });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('text in place only (F1): a name, properties, tags or data supplied alongside - or instead of - the text is refused and spends nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const inputs: Array<Record<string, unknown>> = [
      { name: 'changed name' }, { properties: { injected: true } }, { name: 'n', properties: { injected: true } },
      { content: 'new', name: 'renamed' }, { content: 'new', tags: ['x'] }, { content: 'new', description: 'd' },
    ];
    for (const [i, extra] of inputs.entries()) {
      expect([i, await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, ...extra } }, ctx())))]).toEqual([i, 'BOOT_PROMPT_WORKER_SESSION_REFUSED']);
    }
    expect(await uses(g)).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.content).toBe('original');
    expect(row.name).toBe('Source');
    // control: the same grant admits the content-only edit.
    expect(await codeOf(edit(s.id, 'only text'))).toBe('NO_ERROR');
    expect(await uses(g)).toBe(1);
  });

  it('text in place only (F1): resending the same role and node type with the text is still a text edit', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(s.id);
    expect(await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'same role', role: 'boot-prompt' } }, ctx())))).toBe('NO_ERROR');
  });

  it('text in place only: delete, role strip, node-type change, move and merge stay refused, and spend nothing', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const t = await src(installMemoryId, 'boot:other');
    const g = await grant(s.id);
    const ops = [
      () => asWorker(() => resolvers.Mutation.deleteNode(null, { nodeRef: s.id }, ctx())),
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, role: 'notes' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, nodeType: 'report' } }, ctx())),
      () => asWorker(() => resolvers.Mutation.moveNode(null, { sourceRef: s.id, targetUrn: 'hrn:node:g3823.example:install:elsewhere' }, ctx())),
      () => asWorker(() => resolvers.Mutation.mergeNodes(null, { input: { source: s.id, target: t.id } }, ctx())),
    ];
    for (const [i, op] of ops.entries()) expect([i, await codeOf(op())]).toEqual([i, 'BOOT_PROMPT_WORKER_SESSION_REFUSED']);
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });

  it('a create of a boot-prompt source stays refused (a grant names an existing node)', async () => {
    const g = await grant(generateId());
    expect(await codeOf(asWorker(() => resolvers.Mutation.createNode(null, {
      input: { memoryId: installMemoryId, loc: `boot:workers:${workerId}:source`, name: 'S', role: 'boot-prompt', content: 'x' },
    }, ctx())))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });

  it('a compiled node is never written by a generic edit, grant or not', async () => {
    const c = await db.node.create({ data: { id: generateId(), memoryId: installMemoryId, loc: `boot:workers:${workerId}:compiled`, name: 'C', content: 'c', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } });
    await grant(c.id);
    expect(await codeOf(edit(c.id))).toBe('BOOT_PROMPT_COMPILED_WRITE');
  });

  it('a person editing as themselves (no worker session) is unaffected, and spends no grant', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    await resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'by the manager' } }, ctx());
    expect(await uses(g)).toBe(0);
  });

  it('a refused write leaves the grant unspent (the spend rides the write\'s transaction)', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const stale = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'x', expectedRevSeq: 999 } as never }, ctx())));
    expect(stale).not.toBe('NO_ERROR');
    expect(await uses(g)).toBe(0);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });
});

describe('over MCP (hadron_update_node), the same grant and the same boundary (#3823)', () => {
  // An install memory is writable only through the GraphQL door (access-control.ts canWriteToMemory), so MCP reaches the role
  // Agent's own system-memory source.
  const mcpEdit = (urn: string, content = 'via mcp') => {
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    return asWorker(() => mcp.callToolText('hadron_update_node', { urn, content }).then((t) => String(t), (e: Error) => e.message));
  };
  it('refused without a grant; admitted once with one, recording the worker', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    const urn = 'hrn:node:g3823.example:agent-sys:boot:source';
    expect(await mcpEdit(urn)).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    const g = await grant(s.id);
    expect(await mcpEdit(urn)).not.toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('via mcp');
    expect((await db.nodeRevision.findMany({ where: { nodeId: s.id } })).some((r) => r.editedByWorkerId === workerId)).toBe(true);
    expect(await mcpEdit(urn, 'again')).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });
  it('F1 over MCP: a name or properties supplied with the text is refused and spends nothing', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    const g = await grant(s.id);
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const urn = 'hrn:node:g3823.example:agent-sys:boot:source';
    for (const extra of [{ name: 'renamed' }, { properties: { injected: true } }]) {
      const out = await asWorker(() => mcp.callToolText('hadron_update_node', { urn, content: 'x', ...extra }).then((t) => String(t), (e: Error) => e.message));
      expect(out).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    }
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });
  it('another Agent\'s system-memory source is refused under a grant that names it', async () => {
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'g3823.example:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'g3823.example:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const t = await src(otherMem.id, 'boot:source');
    const g = await grant(t.id);
    expect(await mcpEdit('hrn:node:g3823.example:other-sys:boot:source')).toContain('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });
});

describe('spendEditGrant locks the grant row, THEN judges it (#3823)', () => {
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

describe('the lift is the update door only, in place, signer re-judged (#3823 Riana F1/F3, Andi P2-1)', () => {
  it('Riana F1: updateNodeProperties and updateNodeData are not edit doors: refused, grant unspent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    expect(await codeOf(asWorker(() => resolvers.Mutation.updateNodeProperties(null, { nodeRef: s.id, properties: { injected: true } }, ctx())))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await codeOf(asWorker(() => (resolvers.Mutation as any).updateNodeData(null, { nodeRef: s.id, data: { x: 1 } }, ctx())))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    expect(await codeOf(edit(s.id))).toBe('NO_ERROR');
  });

  it('Riana F1: importNode into an existing own source (content only) is not an edit door either', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    const out = await codeOf(asWorker(() => (resolvers.Mutation as any).importNode(null, {
      input: { memoryId: installMemoryId, loc: s.loc, content: 'imported text', contentType: 'text/markdown' },
    }, ctx())));
    expect(out).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: s.id } })).content).toBe('original');
  });

  it('Andi P2-1: a text edit that names another loc or memory is not in place: refused, unspent', async () => {
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id);
    for (const extra of [{ loc: `boot:workers:${workerId}:moved` }, { memoryId: agentMemoryId }]) {
      const out = await codeOf(asWorker(() => resolvers.Mutation.updateNode(null, { input: { id: s.id, content: 'x', ...extra } as never }, ctx())));
      expect(out).not.toBe('NO_ERROR');
    }
    expect(await uses(g)).toBe(0);
    const row = await db.node.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.loc, row.memoryId, row.content]).toEqual([`boot:workers:${workerId}:source`, installMemoryId, 'original']);
  });

  it('Riana F3: a source in an install memory of ANOTHER App, or of the same App for ANOTHER Agent, is not own', async () => {
    const app2 = await db.app.create({ data: { id: generateId(), name: 'App2', urn: 'g3823.example:app2', organizationId: orgId } });
    await db.appAgent.create({ data: { appId: app2.id, agentId } });
    const other = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i2', urn: 'g3823.example:i2', organizationId: orgId, appId: app2.id, installOfAgentId: agentId, isInstallMemory: true } });
    const a2 = await db.agent.create({ data: { id: generateId(), name: 'A2', urn: 'g3823.example:a2', organizationId: orgId } });
    await db.appAgent.create({ data: { appId, agentId: a2.id } });
    const sameAppOtherAgent = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i3', urn: 'g3823.example:i3', organizationId: orgId, appId, installOfAgentId: a2.id, isInstallMemory: true } });
    for (const memoryId of [other.id, sameAppOtherAgent.id]) {
      const s = await src(memoryId, 'boot:source');
      const g = await grant(s.id);
      expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
      expect(await uses(g)).toBe(0);
    }
  });

  it('Riana F3 (V54): the Agent system-memory source needs a signer who manages the AGENT, not only the App', async () => {
    const s = await src(agentMemoryId, 'boot:source');
    await db.appMember.create({ data: { appId, userId: stranger.id, role: 'owner' } });
    const g = await grant(s.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
    // control: the same signer IS enough for the App's own install-memory source.
    const t = await src(installMemoryId, `boot:workers:${workerId}:source`);
    await grant(t.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(edit(t.id))).toBe('NO_ERROR');
  });

  it('Andi gap: the signer is re-judged at spend time: one who has since lost the App is refused', async () => {
    const second = await db.user.create({ data: { githubId: 382303, githubUsername: 'g-second', handle: 'g-second', roles: [] } });
    const m = await db.orgMember.create({ data: { organizationId: orgId, userId: second.id, role: 'ADMIN' } });
    const s = await src(installMemoryId, `boot:workers:${workerId}:source`);
    const g = await grant(s.id, { verified_by: second.id, issuer_user_id: second.id });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: second.id } }, data: { role: 'CONTRIBUTOR' } }).catch(() => db.orgMember.delete({ where: { id: (m as any).id } } as never));
    expect(await codeOf(edit(s.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await uses(g)).toBe(0);
  });
});

describe('isGrantableEdit, directly (each condition alone defeats the lift)', () => {
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
    expect(isGrantableEdit({ ...prior, nodeType: 'compiled-boot-prompt' }, ok)).toBe(false);
    expect(isGrantableEdit({ ...prior, role: 'notes' }, ok)).toBe(false);
    expect(isGrantableEdit(null, ok)).toBe(false);
  });
});

describe('spendEditGrant re-judges the signer itself (Riana F6)', () => {
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

describe('the MCP door judges the call\'s REAL arguments, so a parameter added later fails closed (Andi P2)', () => {
  it('hadron_update_node derives its non-text fields from the parsed args object, never a hand-kept list', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../mcp/server.ts', import.meta.url)), 'utf8');
    const at = src.indexOf("'hadron_update_node',");
    const body = src.slice(at, at + 20000);
    expect(body).toContain('suppliedNonTextFields(mcpArgs as Record<string, unknown>)');
    expect(body).not.toMatch(/suppliedNonTextFields\(\{/);
  });
});
