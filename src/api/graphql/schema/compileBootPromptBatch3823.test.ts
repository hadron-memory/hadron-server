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
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { hasBatchGrant } from '../../../lib/grants/bootPromptGrant.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import type { Context } from './resolvers.helpers.js';
import { compileBootPrompt } from './compileBootPrompt.js';
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
  pointers: (await db.agent.findMany({ select: { bootPromptNodeId: true }, orderBy: { id: 'asc' } })).map((a) => a.bootPromptNodeId),
  appAgent: (await db.appAgent.findMany({ select: { bootPromptNodeId: true }, orderBy: { appId: 'asc' } })).map((a) => a.bootPromptNodeId),
  workers: (await db.worker.findMany({ select: { bootPromptNodeId: true }, orderBy: { id: 'asc' } })).map((a) => a.bootPromptNodeId),
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

  it('F2: a grant may name another worker\'s compiled prompt of the same App (S7a): admitted; an unnamed one is refused', async () => {
    await source(installId, `boot:workers:${otherWorkerId}:source`, 'otto text');
    const theirs = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    const third = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Cy', slug: 'cy' } });
    await source(installId, `boot:workers:${third.id}:source`, 'cy text');
    await compiled(installId, `boot:workers:${third.id}:compiled`);
    await grant(theirs.id);
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: otherWorkerId }, ctx())))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: theirs.id } })).content).toBe('otto text');
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: third.id }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('F2: a compiled prompt of ANOTHER App is refused even when the grant names it', async () => {
    const { app: app2 } = await createDbAppWithKey(db, 'b-app2', orgId);
    await createDbAppAgent(db, app2.id, agentId);
    const install2 = await db.memory.create({
      data: { id: generateId(), class: 'system', name: 'install2', urn: 'b3823:install2', organizationId: orgId, appId: app2.id, installOfAgentId: agentId, isInstallMemory: true },
    });
    const w2 = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app2.id, agentId, name: 'Zed', slug: 'zed' } });
    await source(install2.id, `boot:workers:${w2.id}:source`);
    const c = await compiled(install2.id, `boot:workers:${w2.id}:compiled`);
    await grant(c.id);
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: w2.id }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await codeOf(asWorker(() => M.approveNode(null, { nodeRef: c.id }, ctx())))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
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

  it('F3 (V53): the App-Agent compile needs the App\'s pointer to ALREADY name the node, and never moves it', async () => {
    await source(installId, 'boot:source', 'app text');
    const c = await compiled(installId, 'boot:compiled');
    const other = await compiled(installId, 'boot:other-compiled');
    await grant(c.id);
    const run = () => asWorker(() => M.compileAppAgentBootPrompt(null, { appRef: appId, agentRef: agentId }, ctx()));
    const before = await snapshot();
    expect(await codeOf(run())).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');          // NULL pointer
    await db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: { bootPromptNodeId: other.id, bootPromptUrn: 'hrn:node:b3823:install:boot:other-compiled' } });
    expect(await codeOf(run())).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');          // a different pointer
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('old');
    await db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: { bootPromptNodeId: c.id, bootPromptUrn: 'hrn:node:b3823:install:boot:compiled' } });
    const r = await run();                                                          // equal pointer
    expect(r.pointerSet).toBe(false);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('app text');
    expect((await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId, agentId } } })).bootPromptNodeId).toBe(c.id);
    expect((await snapshot()).nodes).toBe(before.nodes);                            // a batch compile creates no node
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

describe('the batch gate before and inside the transaction (Riana F2/F4, Anne F4, Andi)', () => {
  it('Riana F2: a worker with NO grant is refused at once even while a person holds the tenant\'s exclusive anchors (no queueing, no CONFLICT)', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    await compiled(installId, `boot:workers:${workerId}:compiled`);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => { await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'agent', id: agentId }], 'exclusive'); locked(); await held; }, { timeout: 20000 });
    await lockedP;
    const t0 = Date.now();
    const code = await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())));
    const took = Date.now() - t0;
    release(); await holder;
    expect(code).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(took).toBeLessThan(3000);
  });

  it('Riana F4: a worker session with no user is refused', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(c.id);
    const noUser = { db, roles: [] } as unknown as Context;
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, noUser)))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('Riana F4: a batch compile never creates the install memory', async () => {
    await db.node.deleteMany({ where: { memoryId: installId } });
    await db.memory.delete({ where: { id: installId } });
    const before = await db.memory.count();
    expect(await codeOf(asWorker(() => M.compileAppAgentBootPrompt(null, { appRef: appId, agentRef: agentId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect(await db.memory.count()).toBe(before);
  });

  it('Anne F4: a grant that expires while the check waits for its lock reads dead (lock, THEN judge on the clock)', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    const g = await grant(c.id, { expires_at: raw(`${DB_NOW} + interval '1500 milliseconds'`) });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const blocker = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM grants WHERE id = ${g} FOR UPDATE`; locked(); await held; }, { timeout: 20000 });
    await lockedP;
    const checker = db.$transaction((tx) => hasBatchGrant(tx, workerId, { id: c.id, memoryId: installId, loc: c.loc }, true), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2300));
    release(); await blocker;
    expect(await checker).toBe(false);
  });

  it('Andi: the compiled node is replaced between the grant check and the write: the new node was never named, so the compile is refused', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(c.id);
    const loc = `boot:workers:${workerId}:compiled`;
    const swap = async (tx: any) => {
      await tx.node.delete({ where: { id: c.id } });
      await withCompileWrite(() => tx.node.create({ data: { id: generateId(), memoryId: installId, loc, name: 'Compiled', content: 'swapped', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
    };
    const code = await codeOf(asWorker(() => compileBootPrompt(ctx(), { kind: 'WORKER', workerId }, { seams: { beforeAssemble: swap } } as never)));
    expect(code).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
    expect((await db.node.findFirst({ where: { memoryId: installId, loc } }))?.content).toBe('old');
  });

  it('a wildcard value names no prompt', async () => {
    await source(installId, `boot:workers:${workerId}:source`);
    await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant('*');
    expect(await codeOf(asWorker(() => M.compileWorkerBootPrompt(null, { workerRef: workerId }, ctx())))).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });

  it('Andi: the approval records the admitting grant', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    const g = await grant(c.id);
    await asWorker(() => M.approveNode(null, { nodeRef: c.id }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedByInfo).toContain(g);
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

  it('F2 (S8): a grant naming another worker\'s compiled node admits its approval; a SOURCE or an unnamed node is refused', async () => {
    const s = await source(installId, `boot:workers:${workerId}:source`);
    const theirs = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    const mine = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant([s.id, theirs.id]);
    for (const id of [s.id, mine.id]) expect(await codeOf(approve(id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await codeOf(approve(theirs.id))).toBe('NO_ERROR');
  });

  it('a plain boot-prompt node squatting a :compiled loc is not a compiled prompt: a grant naming it admits nothing', async () => {
    const squat = await source(installId, `boot:workers:${workerId}:compiled`);
    await grant(squat.id);
    expect(await codeOf(approve(squat.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('F2: a compiled-type node at some other loc of the install memory, or in another Agent\'s system memory, is outside the batch scope', async () => {
    const stray = await compiled(installId, 'notes:stray-compiled');
    const otherMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'other-sys', urn: 'b3823:other-sys', organizationId: orgId } });
    await db.agent.create({ data: { id: generateId(), name: 'Other', urn: 'b3823:other', organizationId: orgId, systemMemoryId: otherMem.id } });
    const foreign = await compiled(otherMem.id, 'boot:compiled');
    await grant([stray.id, foreign.id]);
    for (const id of [stray.id, foreign.id]) expect(await codeOf(approve(id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
  });

  it('Andi P2: a worker session under an App key keeps the refusal: the lift needs a person\'s user and no App key', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(c.id);
    const keyed = { ...ctx(), appKeyId: generateId() } as Context;
    expect(await codeOf(asWorker(() => M.approveNode(null, { nodeRef: c.id }, keyed)))).not.toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedRevNo).toBeNull();
  });

  it('Riana P3-6: approveMemoryNodes (the bulk door) keeps the same shape: an App key refuses, a person\'s session lifts', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    await grant(c.id);
    const keyed = { ...ctx(), appKeyId: generateId() } as Context;
    await asWorker(() => M.approveMemoryNodes(null, { memoryRef: installId }, keyed)).catch(() => undefined);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedRevNo).toBeNull();
    await asWorker(() => M.approveMemoryNodes(null, { memoryRef: installId }, ctx()));
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedRevNo).not.toBeNull();
  });

  it('a person approving as themselves is unaffected', async () => {
    const c = await compiled(installId, `boot:workers:${workerId}:compiled`);
    expect(await codeOf(M.approveNode(null, { nodeRef: c.id }, ctx()))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedBy).toBe(admin.id);
  });
});
