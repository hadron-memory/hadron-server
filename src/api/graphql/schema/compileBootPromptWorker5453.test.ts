/**
 * #5453 PR B (Ask 5; Holger, 2026-11-27, decision record
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:decisions:2026-11-27-holger-rulings-to-bo-system-nodes-and-roles,
 * section 4b: "Yes, also compile") — a worker session compiles with no batch grant.
 *
 * What it may compile: a NEW REVISION of an EXISTING compiled node, in a memory the session may write. "May write"
 * is the memory's own write gate (`requireMemoryWriteAccess`), the one every node write of that memory passes, so
 * it judges the person behind the session: an Agent's system memory is written by whoever manages the Agent, an
 * App's install memory by whoever manages the App while the Agent is installed.
 *
 * What it never does, exactly as under the batch grant before: create a compiled node, set or move a pointer,
 * provision an organisation grant, approve, sign. The access check runs before anything is assembled, so a
 * session that may not write the memory gets the one refusal and learns nothing about the target.
 *
 * Approval is unchanged and pinned here as unchanged: a worker session approves nothing in the family without a
 * batch grant, and what is served is the last APPROVED revision until a person approves the new one.
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
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { withCompileWrite } from '../../../lib/bootPrompt.js';
import { resolveServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import type { Context } from './resolvers.helpers.js';
import { compileBootPrompt } from './compileBootPrompt.js';
import { resolvers } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const COMPILED = 'boot-prompt.compiled';
const SOURCE = 'boot-prompt.source';
const RULE = 'boot-prompt.rule';
const NOT_PERMITTED = 'BOOT_PROMPT_COMPILE_NOT_PERMITTED';
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

let orgId: string;
let manager: { id: string };
/** In the organisation, but no manager of the Agent or the App: may not write either memory. */
let member: { id: string };
let stranger: { id: string };
let appId: string;
let appKeyId: string;
let agentId: string;
let agentName: string;
let agentMemId: string;
let installId: string;
let workerId: string;
let otherWorkerId: string;

const ctxOf = (userId: string | undefined, extra: Record<string, unknown> = {}): Context =>
  ({ db, userId, roles: [], clientId: userId ? `user:${userId}` : undefined, ...extra }) as Context;
const asWorker = <T>(fn: () => Promise<T>, id = workerId) => runAsActor({ workerId: id, agentId: null }, fn);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message); }
};
/** The whole answer: the text and the extensions, so two refusals can be compared for sameness. */
const answerOf = async (p: Promise<unknown>) => {
  try { await p; return { ok: true as const }; } catch (e) {
    const err = e as { message: string; extensions?: Record<string, unknown> };
    return { ok: false as const, message: err.message, extensions: { ...(err.extensions ?? {}) } };
  }
};
const put = (memoryId: string, loc: string, content: string, role: string) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, role, nodeType: 'system' } });
const source = (memoryId: string, loc: string, content = 'You are {{worker.name}}.') => put(memoryId, loc, content, SOURCE);
const compiled = (memoryId: string, loc: string) => withCompileWrite(() => put(memoryId, loc, 'old', COMPILED));
const batchGrant = (nodes: string | string[], holder = workerId) => insertGrantUnguarded({ appId, userId: manager.id } as unknown as World, {
  user_id: null, worker_id: holder, action: 'bootprompt.compile.approve', action_values: { compiledNode: nodes }, activated_at: raw(DB_NOW),
  verification_kind: 'passkey', verified_by: manager.id, issuer_user_id: manager.id, expires_at: raw(`${DB_NOW} + interval '1 hour'`),
} as never);
/** Everything a compile could write, so "nothing changed" is one comparison. */
const snapshot = async () => ({
  nodes: (await db.node.findMany({ select: { id: true, revSeq: true, content: true, approvedRevNo: true, deletedAt: true }, orderBy: { id: 'asc' } })),
  memories: await db.memory.count(),
  compiledRevisions: await db.compiledPromptRevision.count(),
  edges: await db.edge.count(),
  agentPointers: (await db.agent.findMany({ select: { bootPromptNodeId: true }, orderBy: { id: 'asc' } })).map((a) => a.bootPromptNodeId),
  installPointers: (await db.appAgent.findMany({ select: { bootPromptNodeId: true }, orderBy: { appId: 'asc' } })).map((a) => a.bootPromptNodeId),
  workerPointers: (await db.worker.findMany({ select: { bootPromptNodeId: true }, orderBy: { id: 'asc' } })).map((a) => a.bootPromptNodeId),
  agentOrgGrants: await db.agentOrgGrant.count(),
  signatures: await db.nodeSignature.count(),
});
const compileWorker = (ctx: Context, ref = workerId, args: Record<string, unknown> = {}) => M.compileWorkerBootPrompt(null, { workerRef: ref, ...args }, ctx);
const compileAgent = (ctx: Context, args: Record<string, unknown> = {}) => M.compileAgentBootPrompt(null, { agentRef: agentId, ...args }, ctx);
const compileAppAgent = (ctx: Context) => M.compileAppAgentBootPrompt(null, { appRef: appId, agentRef: agentId }, ctx);
const workerSource = () => `boot:workers:${workerId}:source`;
const workerCompiled = () => `boot:workers:${workerId}:compiled`;

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'c-org', urn: 'c5453' } })).id;
  manager = await db.user.create({ data: { id: generateId(), name: 'manager' } });
  member = await db.user.create({ data: { id: generateId(), name: 'member' } });
  stranger = await db.user.create({ data: { id: generateId(), name: 'stranger' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: member.id, role: 'CONTRIBUTOR' } });
  agentMemId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'c5453:agent-sys', organizationId: orgId } })).id;
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'c5453:agent', organizationId: orgId, systemMemoryId: agentMemId } });
  agentId = agent.id;
  agentName = agent.name;
  const { app, appKey } = await createDbAppWithKey(db, 'c-app', orgId);
  appId = app.id;
  appKeyId = appKey.id;
  await createDbAppAgent(db, app.id, agent.id);
  installId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'c5453:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Iris', slug: 'iris' } })).id;
  otherWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Otto', slug: 'otto' } })).id;
  await ensureAgentOrgGrant(db as never, orgId, agentId, { createdBy: manager.id });
});

describe('#5453 Ask 5: a worker session compiles with no grant, where it may write the memory', () => {
  it('a worker\'s prompt: a new, unapproved revision of the existing compiled node, the worker recorded, no pointer, no grant, no signature', async () => {
    await source(installId, workerSource(), 'v1');
    const c = await compiled(installId, workerCompiled());
    const before = await snapshot();
    const r = await asWorker(() => compileWorker(ctxOf(manager.id)));
    expect([r.pointerSet, r.approvalIssued, r.node.id]).toEqual([false, false, c.id]);
    const node = await db.node.findUniqueOrThrow({ where: { id: c.id } });
    expect([node.content, node.revSeq, node.approvedRevNo, node.role, node.nodeType]).toEqual(['v1', c.revSeq + 1, null, COMPILED, 'system']);
    expect(r.revNo).toBe(node.revSeq);
    const revs = await db.nodeRevision.findMany({ where: { nodeId: c.id } });
    expect(revs.some((x) => x.editedByWorkerId === workerId)).toBe(true);
    // Any number of times, each a new revision; nothing else moves.
    await asWorker(() => compileWorker(ctxOf(manager.id)));
    const after = await snapshot();
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).revSeq).toBe(c.revSeq + 2);
    expect(after.compiledRevisions).toBe(before.compiledRevisions + 2);
    expect({ ...after, nodes: 0, compiledRevisions: 0, edges: 0 }).toEqual({ ...before, nodes: 0, compiledRevisions: 0, edges: 0 });
    expect(after.nodes.length).toBe(before.nodes.length);
    expect(await db.grant.count()).toBe(0);
  });

  it('the Agent\'s prompt (system memory): admitted, and the pointer is left as it is whatever the caller asks', async () => {
    await source(agentMemId, 'boot:source', 'agent text');
    const c = await compiled(agentMemId, 'boot:compiled');
    const before = await snapshot();
    const r = await asWorker(() => compileAgent(ctxOf(manager.id), { setPointer: true }));
    expect(r.pointerSet).toBe(false);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('agent text');
    const after = await snapshot();
    expect([after.agentPointers, after.installPointers, after.workerPointers]).toEqual([before.agentPointers, before.installPointers, before.workerPointers]);
    expect(after.nodes.length).toBe(before.nodes.length);
  });

  it('an App\'s compiled Agent prompt whose pointer already names the node: admitted, the pointer untouched', async () => {
    await source(installId, 'boot:source', 'app text');
    const c = await compiled(installId, 'boot:compiled');
    await db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: { bootPromptNodeId: c.id, bootPromptUrn: 'hrn:node:c5453:install:boot:compiled' } });
    const r = await asWorker(() => compileAppAgent(ctxOf(manager.id)));
    expect(r.pointerSet).toBe(false);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('app text');
    expect((await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId, agentId } } })).bootPromptNodeId).toBe(c.id);
  });

  it('another worker\'s prompt in the same install memory: the memory gate decides, not whose prompt it is ("Wider, for now")', async () => {
    await source(installId, `boot:workers:${otherWorkerId}:source`, 'otto text');
    const theirs = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(manager.id), otherWorkerId)))).toBe('NO_ERROR');
    expect((await db.node.findUniqueOrThrow({ where: { id: theirs.id } })).content).toBe('otto text');
  });

  it('edit, then compile: the new revision carries the worker\'s edit, and a bind, a chat and a run are still served the last APPROVED revision until a person approves', async () => {
    // A person sets the prompt up: source, first compile (which sets the Agent's pointer), approval.
    const s = await source(agentMemId, 'boot:source', 'approved text');
    const first = await compileAgent(ctxOf(manager.id));
    await M.approveNode(null, { nodeRef: first.node.id }, ctxOf(manager.id));
    const served = async () => {
      const out: Array<[string, string, number]> = [];
      for (const surface of ['bind', 'chat', 'run'] as const) {
        const r = await resolveServedBootPrompt(db, { surface, appId, agent: { id: agentId, name: agentName }, workerId: surface === 'bind' ? workerId : null });
        out.push([surface, r.content, r.servedRevSeq]);
      }
      return out;
    };
    const approvedRev = (await db.node.findUniqueOrThrow({ where: { id: first.node.id } })).approvedRevNo!;
    expect(await served()).toEqual([['bind', 'approved text', approvedRev], ['chat', 'approved text', approvedRev], ['run', 'approved text', approvedRev]]);
    // The worker session edits the source and compiles, with no grant.
    await asWorker(() => M.updateNode(null, { input: { ref: s.id, content: 'the worker\'s new text' } }, ctxOf(manager.id)));
    const second = await asWorker(() => compileAgent(ctxOf(manager.id)));
    const node = await db.node.findUniqueOrThrow({ where: { id: first.node.id } });
    expect([node.content, node.revSeq > approvedRev, node.approvedRevNo, second.approvalIssued]).toEqual(['the worker\'s new text', true, approvedRev, false]);
    expect(await served()).toEqual([['bind', 'approved text', approvedRev], ['chat', 'approved text', approvedRev], ['run', 'approved text', approvedRev]]);
    // The session cannot approve its own compile; a person does, and only then is the new text served.
    expect(await codeOf(asWorker(() => M.approveNode(null, { nodeRef: node.id }, ctxOf(manager.id))))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await served()).toEqual([['bind', 'approved text', approvedRev], ['chat', 'approved text', approvedRev], ['run', 'approved text', approvedRev]]);
    await M.approveNode(null, { nodeRef: node.id }, ctxOf(manager.id));
    expect((await served()).map((x) => x[1])).toEqual(['the worker\'s new text', 'the worker\'s new text', 'the worker\'s new text']);
  });
});

describe('#5453 Ask 5: what a worker session\'s compile never does', () => {
  it('it never creates a compiled node: with none there it is refused and nothing is written', async () => {
    await source(installId, workerSource());
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(manager.id))))).toBe(NOT_PERMITTED);
    expect(await snapshot()).toEqual(before);
    // The same compile by the person creates it (the control: the source is fine).
    expect(await codeOf(compileWorker(ctxOf(manager.id)))).toBe('NO_ERROR');
  });

  it('a node at the compiled address that is not compiled by role is not "an existing compiled node": refused, before the write step\'s CONFLICT', async () => {
    await source(installId, workerSource(), 'v1');
    const squat = await put(installId, workerCompiled(), 'old', SOURCE);
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(manager.id))))).toBe(NOT_PERMITTED);
    expect(await snapshot()).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: squat.id } })).content).toBe('old');
  });

  it('it never sets or moves a pointer: an App-level compile is refused unless the App\'s pointer already names the node', async () => {
    await source(installId, 'boot:source', 'app text');
    const c = await compiled(installId, 'boot:compiled');
    const other = await compiled(installId, 'boot:other-compiled');
    const run = () => asWorker(() => compileAppAgent(ctxOf(manager.id)));
    const before = await snapshot();
    expect(await codeOf(run())).toBe(NOT_PERMITTED);                                  // no pointer: the compile would set it
    expect(await snapshot()).toEqual(before);
    await db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: { bootPromptNodeId: other.id, bootPromptUrn: 'hrn:node:c5453:install:boot:other-compiled' } });
    expect(await codeOf(run())).toBe(NOT_PERMITTED);                                  // another node: the compile would move it
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('old');
    expect((await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId, agentId } } })).bootPromptNodeId).toBe(other.id);
  });

  it('it never sets a worker\'s or an Agent\'s pointer either: setPointer true changes none', async () => {
    await source(installId, workerSource(), 'v1');
    await compiled(installId, workerCompiled());
    await source(agentMemId, 'boot:source', 'agent text');
    await compiled(agentMemId, 'boot:compiled');
    const before = await snapshot();
    expect((await asWorker(() => compileWorker(ctxOf(manager.id), workerId, { setPointer: true }))).pointerSet).toBe(false);
    expect((await asWorker(() => compileAgent(ctxOf(manager.id), { setPointer: true }))).pointerSet).toBe(false);
    const after = await snapshot();
    expect([after.agentPointers, after.installPointers, after.workerPointers]).toEqual([before.agentPointers, before.installPointers, before.workerPointers]);
    expect(after.workerPointers.every((p) => p === null) && after.agentPointers.every((p) => p === null)).toBe(true);
  });

  it('it never provisions an organisation grant: a compile that would is refused BOOT_PROMPT_GRANT_REQUIRED and creates none', async () => {
    await db.agentOrgGrant.deleteMany({});
    await source(installId, workerSource());
    await compiled(installId, workerCompiled());
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(manager.id))))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect(await snapshot()).toEqual(before);
    // The same compile by the person provisions it, as before.
    await compileWorker(ctxOf(manager.id));
    expect(await db.agentOrgGrant.count()).toBeGreaterThan(0);
  });

  it('it never creates the install memory', async () => {
    await db.node.deleteMany({ where: { memoryId: installId } });
    await db.memory.delete({ where: { id: installId } });
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileAppAgent(ctxOf(manager.id))))).toBe(NOT_PERMITTED);
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(manager.id))))).toBe(NOT_PERMITTED);
    expect(await snapshot()).toEqual(before);
  });

  it('the compiled node is replaced between the check and the write: the new node was never the one judged, so nothing is written to it', async () => {
    await source(installId, workerSource());
    const c = await compiled(installId, workerCompiled());
    const swap = async (tx: any) => {
      await tx.node.delete({ where: { id: c.id } });
      await withCompileWrite(() => tx.node.create({ data: { id: generateId(), memoryId: installId, loc: workerCompiled(), name: 'Compiled', content: 'swapped', role: COMPILED, nodeType: 'system' } }));
    };
    expect(await codeOf(asWorker(() => compileBootPrompt(ctxOf(manager.id), { kind: 'WORKER', workerId }, { seams: { beforeAssemble: swap } } as never)))).toBe(NOT_PERMITTED);
    expect((await db.node.findFirst({ where: { memoryId: installId, loc: workerCompiled() } }))?.content).toBe('old');
  });
});

describe('#5453 Ask 5: a session that may not write the memory is refused before anything is assembled, and learns nothing', () => {
  /** A target every refusal is compared with: a worker, an Agent and an App that do not exist. */
  const nothingThere = async (ctx: Context) => [
    await answerOf(asWorker(() => compileWorker(ctx, generateId()))),
    await answerOf(asWorker(() => M.compileAgentBootPrompt(null, { agentRef: generateId() }, ctx))),
    await answerOf(asWorker(() => M.compileAppAgentBootPrompt(null, { appRef: generateId(), agentRef: agentId }, ctx))),
  ];

  it.each([['a member who manages neither the Agent nor the App', () => member], ['a stranger to the organisation', () => stranger]])(
    'held by %s: one answer for a target with a compiled node, one with none, one whose source cannot compile, a retired one, and one that does not exist',
    async (_who, holderOf) => {
      const ctx = ctxOf(holderOf().id);
      await source(installId, workerSource(), 'v1');
      await compiled(installId, workerCompiled());                                       // Iris: everything a compile needs
      await source(installId, `boot:workers:${otherWorkerId}:source`, 'v1');             // Otto: no compiled node yet
      await source(agentMemId, 'boot:source', 'a {{> parts:missing}} b');                // the Agent's: a broken include
      await compiled(agentMemId, 'boot:compiled');
      const retired = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Rae', slug: 'rae', retiredAt: new Date() } });
      await source(installId, `boot:workers:${retired.id}:source`, 'v1');
      await compiled(installId, `boot:workers:${retired.id}:compiled`);
      const before = await snapshot();
      const absent = await nothingThere(ctx);
      expect(new Set(absent.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(absent[0]).toMatchObject({ ok: false, extensions: { code: NOT_PERMITTED } });
      const answers = {
        withCompiledNode: await answerOf(asWorker(() => compileWorker(ctx))),
        withoutCompiledNode: await answerOf(asWorker(() => compileWorker(ctx, otherWorkerId))),
        brokenSource: await answerOf(asWorker(() => compileAgent(ctx))),
        retired: await answerOf(asWorker(() => compileWorker(ctx, retired.id))),
        appLevel: await answerOf(asWorker(() => compileAppAgent(ctx))),
      };
      for (const [name, answer] of Object.entries(answers)) expect([name, answer]).toEqual([name, absent[0]]);
      expect(await snapshot()).toEqual(before);
      // What the refusal hides: a session that MAY write these memories is told each of those facts.
      const writer = ctxOf(manager.id);
      expect(await codeOf(asWorker(() => compileAgent(writer)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
      expect(await codeOf(asWorker(() => compileWorker(writer, retired.id)))).toBe('BOOT_PROMPT_TARGET_RETIRED');
    },
  );

  it('the same holder as a person, with no worker session, gets that same answer', async () => {
    await source(installId, workerSource(), 'v1');
    await compiled(installId, workerCompiled());
    const asPerson = await answerOf(compileWorker(ctxOf(member.id)));
    const asSession = await answerOf(asWorker(() => compileWorker(ctxOf(member.id))));
    expect(asSession).toEqual(asPerson);
    expect(asSession).toMatchObject({ ok: false, extensions: { code: NOT_PERMITTED } });
  });

  it('it is refused at once, without queueing on the tenant\'s exclusive anchors (no CONFLICT, no wait)', async () => {
    await source(installId, workerSource());
    await compiled(installId, workerCompiled());
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => { await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, { kind: 'agent', id: agentId }], 'exclusive'); locked(); await held; }, { timeout: 20000 });
    await lockedP;
    const t0 = Date.now();
    const code = await codeOf(asWorker(() => compileWorker(ctxOf(member.id))));
    const took = Date.now() - t0;
    release(); await holder;
    expect(code).toBe(NOT_PERMITTED);
    expect(took).toBeLessThan(3000);
  });

  it.each([
    ['the App (an install memory)', () => ({ kind: 'WORKER' as const, workerId }), () => ({ memoryId: installId, src: workerSource(), out: workerCompiled() })],
    ['the Agent (its system memory)', () => ({ kind: 'AGENT' as const, agentId }), () => ({ memoryId: agentMemId, src: 'boot:source', out: 'boot:compiled' })],
  ])('a holder who stops managing %s after the first check is refused on the live state, before anything is assembled', async (_what, targetOf, where) => {
    const { memoryId, src, out } = where();
    await source(memoryId, src, 'a {{> parts:missing}} b');   // assembling this would answer BOOT_PROMPT_INCLUDE_UNAVAILABLE
    const c = await compiled(memoryId, out);
    const demote = async () => { await db.orgMember.updateMany({ where: { organizationId: orgId, userId: manager.id }, data: { role: 'CONTRIBUTOR' } }); };
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileBootPrompt(ctxOf(manager.id), targetOf(), { seams: { beforeFence: demote } } as never)))).toBe(NOT_PERMITTED);
    expect(await snapshot()).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('old');
  });

  it('a session with no person behind it, one under an App key, an impersonation and a run are refused', async () => {
    await source(installId, workerSource());
    const c = await compiled(installId, workerCompiled());
    const shapes: Array<[string, Context]> = [
      ['no user', ctxOf(undefined)],
      ['an App key', ctxOf(manager.id, { appKeyId })],
      ['an impersonation', ctxOf(manager.id, { impersonation: { actorId: stranger.id } })],
      ['a run', ctxOf(manager.id, { clientId: 'run:some-run' })],
    ];
    for (const [name, ctx] of shapes) expect([name, await codeOf(asWorker(() => compileWorker(ctx)))]).toEqual([name, NOT_PERMITTED]);
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).content).toBe('old');
  });

  it('a batch grant does not make a memory writable: a session that may not write it is refused the compile, grant or not', async () => {
    await source(installId, workerSource());
    const c = await compiled(installId, workerCompiled());
    await batchGrant(c.id);
    const before = await snapshot();
    expect(await codeOf(asWorker(() => compileWorker(ctxOf(member.id))))).toBe(NOT_PERMITTED);
    expect(await snapshot()).toEqual(before);
  });
});

describe('#5453 Ask 5 leaves approval where it was: a worker session approves nothing in the family without a batch grant', () => {
  const approve = (id: string, ctx = ctxOf(manager.id)) => asWorker(() => M.approveNode(null, { nodeRef: id }, ctx));
  const family = async (memoryId: string, prefix: string) => ({
    source: await source(memoryId, `${prefix}source`),
    rule: await put(memoryId, 'boot:rules:core', 'Post in the channel.', RULE),
    compiled: await compiled(memoryId, `${prefix}compiled`),
  });

  it.each([
    ['an App\'s install memory', () => installId, () => `boot:workers:${workerId}:`],
    ['the Agent\'s system memory', () => agentMemId, () => 'boot:'],
  ])('in %s: a source, a rule and a compiled node are each refused to a manager\'s worker, one at a time and in bulk; the manager approves each', async (_where, memoryOf, prefixOf) => {
    const nodes = await family(memoryOf(), prefixOf());
    for (const [kind, n] of Object.entries(nodes)) {
      expect([kind, await codeOf(approve(n.id))]).toEqual([kind, 'BOOT_PROMPT_WORKER_SESSION_REFUSED']);
    }
    const bulk = await asWorker(() => M.approveMemoryNodes(null, { memoryRef: memoryOf() }, ctxOf(manager.id)));
    expect([bulk.approvedCount, bulk.skippedBootPromptCount]).toEqual([0, 3]);
    for (const n of Object.values(nodes)) expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvedRevNo).toBeNull();
    for (const [kind, n] of Object.entries(nodes)) {
      expect([kind, await codeOf(M.approveNode(null, { nodeRef: n.id }, ctxOf(manager.id)))]).toEqual([kind, 'NO_ERROR']);
      expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvedBy).toBe(manager.id);
    }
  });

  it('with a batch grant naming the compiled node it approves that node only: not the source, not the rule, not another compiled node', async () => {
    const nodes = await family(installId, `boot:workers:${workerId}:`);
    const otherCompiled = await compiled(installId, `boot:workers:${otherWorkerId}:compiled`);
    await batchGrant([nodes.compiled.id, nodes.source.id, nodes.rule.id]);
    for (const n of [nodes.source, nodes.rule, otherCompiled]) expect(await codeOf(approve(n.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect(await codeOf(approve(nodes.compiled.id))).toBe('NO_ERROR');
    const approved = await db.node.findUniqueOrThrow({ where: { id: nodes.compiled.id } });
    expect([approved.approvedRevNo, approved.approvedBy]).toEqual([approved.revSeq, null]);
    expect(approved.approvedByInfo).toContain(workerId);
    for (const n of [nodes.source, nodes.rule, otherCompiled]) expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvedRevNo).toBeNull();
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('compiling gives no right to approve: after its own grant-free compile the session is still refused the approval', async () => {
    await source(installId, workerSource(), 'v1');
    const c = await compiled(installId, workerCompiled());
    await asWorker(() => compileWorker(ctxOf(manager.id)));
    expect(await codeOf(approve(c.id))).toBe('BOOT_PROMPT_WORKER_SESSION_REFUSED');
    expect((await db.node.findUniqueOrThrow({ where: { id: c.id } })).approvedRevNo).toBeNull();
  });
});
