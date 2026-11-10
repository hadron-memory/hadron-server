/**
 * #3823 (ruling 0267; V49, V52, V53; cor:agt:040:12 r21, cor:agt:040:18 r9) — a worker session compiles and approves only under a
 * BATCH grant: it names the compiled prompts it covers, lasts an hour, has no use count and never signs. A batch compile writes a
 * new revision of a compiled node the grant names; it never creates one, sets a pointer or provisions an AgentOrgGrant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import type { Context } from './resolvers.helpers.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const BATCH = 'bootprompt.compile.approve';
let orgId: string;
let admin: { id: string };
let stranger: { id: string };
let appId: string;
let agentId: string;
let agentMemId: string;
let installId: string;
let workerId: string;
let otherWorkerId: string;
const ctx = (): Context => ({ db, userId: admin.id, roles: [], clientId: `user:${admin.id}` }) as Context;
const asWorker = <T>(fn: () => Promise<T>, id = workerId) => runAsActor({ workerId: id, agentId: null }, fn);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message); }
};
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
const source = (memoryId: string, loc: string, content = 'You are {{worker.name}}.') =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, role: 'boot-prompt' } });
const compiled = (memoryId: string, loc: string) => withCompileWrite(() => db.node.create({
  data: { id: generateId(), memoryId, loc, name: 'Compiled', content: 'old', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
}));
const grant = (nodes: string | string[], over: Record<string, unknown> = {}) => insertGrantUnguarded({ appId, userId: admin.id } as unknown as World, {
  user_id: null, worker_id: workerId, action: BATCH, action_values: { compiledNode: nodes }, activated_at: raw(DB_NOW),
  verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id, expires_at: raw(`${DB_NOW} + interval '1 hour'`), ...over,
} as never);
const snapshot = async () => ({
  nodes: await db.node.count(), revisions: await db.compiledPromptRevision.count(),
  pointers: (await db.agent.findMany({ select: { bootPromptNodeId: true } })).map((a) => a.bootPromptNodeId),
  appAgent: (await db.appAgent.findMany({ select: { bootPromptNodeId: true } })).map((a) => a.bootPromptNodeId),
  workers: (await db.worker.findMany({ select: { bootPromptNodeId: true } })).map((a) => a.bootPromptNodeId),
  agentOrgGrants: await db.agentOrgGrant.count(),
});

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'b-org', urn: 'b3823' } })).id;
  admin = await db.user.create({ data: { id: generateId(), name: 'admin' } });
  stranger = await db.user.create({ data: { id: generateId(), name: 'stranger' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'b3823:agent-sys', organizationId: orgId } });
  agentMemId = mem.id;
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'b3823:agent', organizationId: orgId, systemMemoryId: mem.id } });
  agentId = agent.id;
  const { app } = await createDbAppWithKey(db, 'b-app', orgId);
  appId = app.id;
  await createDbAppAgent(db, app.id, agent.id);
  installId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'b3823:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
  await ensureAgentOrgGrant(db as never, orgId, agentId, { createdBy: admin.id });
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Otto', slug: 'otto' } })).id;
});

describe('compile under a batch grant', () => {
  it('no grant: still BOOT_PROMPT_COMPILE_NOT_PERMITTED, nothing written', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    await compiled(installId, `boot:workers:${workerId}:compiled`);
    const before = await snapshot();
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await snapshot()).toEqual(before);
  });

  it('a grant naming the worker\'s compiled node: a new revision, many times, no pointer change, the worker recorded', async () => {
    await source(installId, `boot:workers:${workerId}:source`, 'v1');
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    const g = await grant(c.id);
    const before = await snapshot();
    const r = await asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx()));
    expect(r.pointerSet).toBe(false);
    await asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx()));
    const node = await db.node.findUniqueOrThrow({ where: { id: c.id } });
    expect(node.content).toBe('v1');
    expect((await snapshot()).pointers).toEqual(before.pointers);
    expect((await snapshot()).nodes).toBe(before.nodes);
    const revs = await db.nodeRevision.findMany({ where: { nodeId: c.id } });
    expect(revs.some((x) => x.editedByWorkerId === workerId)).toBe(true);
    expect(await db.grantEvent.count({ where: { grantId: g, action: 'USE' } })).toBe(0);
  });

  it('a batch compile never creates a compiled node: with none present it is refused and writes nothing', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    await grant(generateId());
    const before = await snapshot();
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await snapshot()).toEqual(before);
  });

  it('another worker\'s compile target is refused even under a grant that names its node', async () => {
    await source(installId, `boot:workers:${otherWorkerId}:source`);
    const c = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    await grant(c.id);
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: otherWorkerId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('a grant for a different node, an hour-old grant, a revoked one, a stranger-signed one: each refused', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(generateId());
    await grant(c.id, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`), expires_at: raw(`${DB_NOW} + interval '1 day'`) });
    await grant(c.id, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    await grant(c.id, { verified_by: stranger.id, issuer_user_id: stranger.id });
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('the Agent compile (system memory) under a grant naming boot:compiled: admitted, pointer untouched', async () => {
    await source(agentMemId, 'boot:source', 'agent text');
    const c = await compiled(agentMemId, 'boot:compiled');
    await grant([c.id]);
    const before = await snapshot();
    await asWorker(() => M.compileAgentBootPrompt(null, { agentRef: agentId, setPointer: true }, ctx()));
    expect((await snapshot()).pointers).toEqual(before.pointers);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('agent text');
  });

  it('the App-Agent compile never sets a pointer under a batch grant', async () => {
    await source(installId, 'boot:source', 'app text');
    const c = await compiled(installId, 'boot:compiled');
    await grant(c.id);
    const before = await snapshot();
    const r = await asWorker(() => M.compileAppAgentBootPrompt(null, { appRef: appId, agentRef: agentId }, ctx()));
    expect(r.pointerSet).toBe(false);
    expect(await snapshot()).toMatchObject({ pointers: before.pointers, appAgent: before.appAgent });
  });
});

describe('a batch compile provisions nothing (V53)', () => {
  it('with no AgentOrgGrant for the Agent the compile is refused BOOT_PROMPT_GRANT_REQUIRED and creates none', async () => {
    await db.agentOrgGrant.deleteMany({});
    await source(installId, `boot:workers:${workerId}:source`);
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(c.id);
    const before = await snapshot();
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect(await snapshot()).toEqual(before);
    // the same compile by a person (no session) still provisions it, as before
    await M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx());
    expect(await db.agentOrgGrant.count()).toBeGreaterThan(0);
  });
});

describe('approval under a batch grant', () => {
  const approve = (id: string) => asWorker(() => M.approveNode(null, { nodeRef: id }, ctx()));

  it('no grant: BOOT_PROMPT_WORKER_SESSION_REFUSED; with one naming the compiled node: approved, as the worker, with no signature', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    expect(await codeOf(approve(c.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    await grant(c.id);
    expect(await codeOf(approve(c.id))).toBe('NO_ERROR');
    const n = await db.node.findUniqueOrThrow({ where: { id: c.id } });
    expect(n.approvedRevNo).toBe(n.revSeq);
    expect(n.approvedBy).toBeNull();
    expect(n.approvedByInfo).toContain(workerId);
    expect(await db.nodeSignature.count({ where: { nodeId: c.id } } as never)).toBe(0);
  });

  it('a grant never lets a worker approve a SOURCE, another worker\'s compiled node, or a node it does not name', async () => {
    const s = await source(installId, `boot:workers:${workerId}:source`);
    const theirs = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    const mine = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant([s.id, theirs.id]);
    for (const id of [s.id, theirs.id, mine.id]) expect(await codeOf(approve(id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('a person approving as themselves is unaffected', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    expect(await codeOf(M.approveNode(null, { nodeRef: c.id }, ctx()))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedBy).toBe(admin.id);
  });
});
