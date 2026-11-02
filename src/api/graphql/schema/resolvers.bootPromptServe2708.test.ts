/**
 * #2708 (cor:agt:040:07/:10) — the read-only "what a bind would be served now" field on Agent, AppAgent and Worker.
 *
 * Each target's `bootPromptServe` is computed by the resolver a bind uses (#2047 S10), so the field and a real bind can
 * never disagree: the field names a revision exactly when the bind is served that revision, and carries the bind's typed
 * code exactly when the bind is refused, never a fallback. Each field sits behind its target's existing pointer gate
 * (#2045) and no wider, and the gate is judged BEFORE anything is resolved, so a masked caller learns nothing (not even
 * BOOT_PROMPT_NOT_SET).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const R = resolvers as any;
let org: any, app: any, agent: any, admin: any, member: any, stranger: any, worker: any, memoryId: string;

const ctxOf = (userId: string | undefined, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], clientId: userId ? `user:${userId}` : undefined, ...extra }) as Context;
const ctx = () => ctxOf(admin.id);
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const bind = (workerId = worker.id) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: workerId, force: true, llmModel: 'm-1' } }, ctx());
const lastRecord = () => db.servedPrompt.findFirst({ orderBy: { servedAt: 'desc' } });

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function approve(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
async function compiled(content: string, approved = true) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId().slice(-10)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  if (approved) await approve(node.id);
  return node.id as string;
}
async function recompileApproved(nodeId: string, content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(nodeId);
}
const pointer = (id: string) => ({ bootPromptNodeId: id, bootPromptUrn: `u:${id}` });
const pointAgent = (id: string) => db.agent.update({ where: { id: agent.id }, data: pointer(id) });
const pointInstall = (id: string) => db.appAgent.update({ where: { appId_agentId: { appId: app.id, agentId: agent.id } }, data: pointer(id) });
const pointWorker = (id: string) => db.worker.update({ where: { id: worker.id }, data: pointer(id) });

const rows = async () => ({
  Agent: await db.agent.findUniqueOrThrow({ where: { id: agent.id } }),
  AppAgent: await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } }),
  Worker: await db.worker.findUniqueOrThrow({ where: { id: worker.id } }),
});
type Target = 'Agent' | 'AppAgent' | 'Worker';
const TARGETS: Target[] = ['Agent', 'AppAgent', 'Worker'];
async function serve(type: Target, c: Context = ctx()) {
  return R[type].bootPromptServe((await rows())[type], {}, c);
}
/** The field's answer in the bind's own vocabulary: the served revision, or the refusal code. */
async function answer(type: Target, c: Context = ctx()) {
  const out = await serve(type, c);
  if (out === null) return 'MASKED';
  if ((out.served === null) === (out.refusal === null)) throw new Error(`exactly one of served/refusal must be set: ${JSON.stringify(out)}`);
  return out.refusal ?? `rev ${out.served.compiledNodeId}@${out.served.servedRevSeq}`;
}
/** What a real bind of the cast worker does: refused with a code, or the revision its record names. */
async function bindAnswer(workerId = worker.id) {
  const c = await codeOf(bind(workerId));
  if (c !== 'RESOLVED') return c;
  const rec = (await lastRecord())!;
  return `rev ${rec.compiledNodeId}@${rec.servedRevSeq}`;
}

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Serve2708', urn: `serve2708-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 92708001, githubUsername: `admin-${n}`, roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 92708002, githubUsername: `member-${n}`, roles: ['READER'] } });
  stranger = await db.user.create({ data: { githubId: 92708003, githubUsername: `stranger-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } as never });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'tester', description: 'd' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Iris' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: `${org.urn}:sys`, organizationId: org.id } })).id;
});

describe('#2708 the field and a real bind agree on every "nothing served" case', () => {
  it('no pointer anywhere: all three fields say BOOT_PROMPT_NOT_SET, and the bind is refused BOOT_PROMPT_NOT_SET', async () => {
    for (const t of TARGETS) expect(await answer(t)).toBe('BOOT_PROMPT_NOT_SET');
    expect(await bindAnswer()).toBe('BOOT_PROMPT_NOT_SET');
  });

  it('an unapproved compiled node: the field says BOOT_PROMPT_NOT_APPROVED exactly as the bind is refused', async () => {
    await pointAgent(await compiled('x', false));
    for (const t of TARGETS) expect(await answer(t)).toBe('BOOT_PROMPT_NOT_APPROVED');
    expect(await bindAnswer()).toBe('BOOT_PROMPT_NOT_APPROVED');
  });

  it('a deleted install target is TARGET_DELETED for the install and the worker, never a fall-through to the live Agent pointer', async () => {
    const live = await compiled('agent text');
    await pointAgent(live);
    const gone = await compiled('install text');
    await pointInstall(gone);
    await db.node.delete({ where: { id: gone } });
    expect(await answer('Agent')).toBe(`rev ${live}@1`); // the Agent pointer alone, saying nothing about the install
    expect(await answer('AppAgent')).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await answer('Worker')).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await bindAnswer()).toBe('BOOT_PROMPT_TARGET_DELETED');
  });

  it("a customised worker's deleted target: the worker field and its bind say TARGET_DELETED; the App's uncustomised answer is unchanged", async () => {
    const live = await compiled('agent text');
    await pointAgent(live);
    const gone = await compiled('worker text');
    await pointWorker(gone);
    await db.node.delete({ where: { id: gone } });
    expect(await answer('Worker')).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await bindAnswer()).toBe('BOOT_PROMPT_TARGET_DELETED');
    expect(await answer('AppAgent')).toBe(`rev ${live}@1`);
    expect(await answer('Agent')).toBe(`rev ${live}@1`);
  });
});

describe('#2708 the field names the revision the next bind records', () => {
  it('after approving a new revision, each field and the next bind name the same revision, at the right pointer level', async () => {
    const node = await compiled('v1');
    await pointAgent(node);
    expect(await answer('Worker')).toBe(await bindAnswer());
    await recompileApproved(node, 'v2');
    const fields = await Promise.all(TARGETS.map((t) => answer(t)));
    expect(fields).toEqual([`rev ${node}@2`, `rev ${node}@2`, `rev ${node}@2`]);
    expect(await bindAnswer()).toBe(`rev ${node}@2`);
    const out = await serve('Worker');
    const rec = (await lastRecord())!;
    expect(out.served).toEqual({
      pointerLevel: rec.pointerLevel, compiledNodeId: rec.compiledNodeId, servedRevSeq: rec.servedRevSeq,
      provenanceRevSeq: rec.provenanceRevSeq, compiledContentHash: rec.compiledContentHash,
    });
  });

  it('each target answers at its own level: worker, then install, then Agent', async () => {
    const a = await compiled('agent'); const i = await compiled('install'); const w = await compiled('worker');
    await pointAgent(a); await pointInstall(i); await pointWorker(w);
    expect((await serve('Agent')).served.pointerLevel).toBe('AGENT');
    expect((await serve('AppAgent')).served).toMatchObject({ pointerLevel: 'APP_AGENT', compiledNodeId: i });
    expect((await serve('Worker')).served).toMatchObject({ pointerLevel: 'WORKER', compiledNodeId: w });
    expect(await bindAnswer()).toBe(`rev ${w}@1`);
  });
});

describe('#2708 gates: each field behind its target\'s pointer gate, judged before anything is resolved', () => {
  it('a stranger and an anonymous caller see null on every target, even when nothing is set (no NOT_SET oracle)', async () => {
    for (const t of TARGETS) {
      expect(await serve(t, ctxOf(stranger.id))).toBeNull();
      expect(await serve(t, ctxOf(undefined))).toBeNull();
    }
    await pointAgent(await compiled('x'));
    for (const t of TARGETS) expect(await serve(t, ctxOf(stranger.id))).toBeNull();
  });

  it("a PUBLIC Agent's outsider reaches the Agent but not this field", async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    expect(await serve('Agent', ctxOf(stranger.id))).toBeNull();
    expect(await serve('Agent', ctx())).not.toBeNull();
  });

  it('a deleted App masks the install and worker fields', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect(await serve('AppAgent')).toBeNull();
    expect(await serve('Worker')).toBeNull();
  });

  it.each(TARGETS)('%s: visible to exactly the callers who see bootPromptRef (admin, member, stranger, anonymous, impersonation)', async (t) => {
    const a = await compiled('agent'); const i = await compiled('install'); const w = await compiled('worker');
    await pointAgent(a); await pointInstall(i); await pointWorker(w);
    const callers: Array<[string, Context]> = [
      ['admin', ctxOf(admin.id)],
      ['member', ctxOf(member.id)],
      ['stranger', ctxOf(stranger.id)],
      ['anonymous', ctxOf(undefined)],
      ['impersonation', ctxOf(admin.id, { impersonation: { orgId: org.id } } as Partial<Context>)],
    ];
    const row = (await rows())[t];
    const seen: Record<string, [boolean, boolean]> = {};
    for (const [name, c] of callers) {
      seen[name] = [(await R[t].bootPromptRef(row, {}, c)) !== null, (await R[t].bootPromptServe(row, {}, c)) !== null];
    }
    for (const [name, [ref, served]] of Object.entries(seen)) expect([name, served]).toEqual([name, ref]);
    expect(seen.admin).toEqual([true, true]);
    expect(seen.stranger).toEqual([false, false]);
  });
});

describe('#2708 the public SDL', () => {
  it('executes the three fields through the schema, with the refusal enum and the decision shape', async () => {
    const node = await compiled('x');
    await pointAgent(node);
    const response = await graphql({
      schema: buildSchema(typeDefs),
      source: `query($w: ID!, $a: ID!) {
        worker(ref: $w) { bootPromptServe { refusal served { pointerLevel compiledNodeId servedRevSeq provenanceRevSeq compiledContentHash } } }
        agent(ref: $a) { bootPromptServe { refusal served { pointerLevel servedRevSeq } } }
        app(ref: "${app.id}") { appAgents { bootPromptServe { refusal served { pointerLevel } } } }
      }`,
      variableValues: { w: worker.id, a: agent.id },
      contextValue: ctx(),
      fieldResolver: (parent, args, context, info) => {
        const fields = R[info.parentType.name] as Record<string, Function> | undefined;
        const fn = fields?.[info.fieldName];
        return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
      },
    });
    expect(response.errors).toBeUndefined();
    expect(response.data).toMatchObject({
      worker: { bootPromptServe: { refusal: null, served: { pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1, provenanceRevSeq: 1, compiledContentHash: sha256Hex('x') } } },
      agent: { bootPromptServe: { refusal: null, served: { pointerLevel: 'AGENT', servedRevSeq: 1 } } },
      app: { appAgents: [{ bootPromptServe: { refusal: null, served: { pointerLevel: 'AGENT' } } }] },
    });
    await db.node.update({ where: { id: node }, data: { approvedRevNo: null, approvedAt: null, approvedByInfo: null, approvalHash: null } });
    const refused = await graphql({
      schema: buildSchema(typeDefs),
      source: 'query($w: ID!) { worker(ref: $w) { bootPromptServe { refusal served { servedRevSeq } } } }',
      variableValues: { w: worker.id }, contextValue: ctx(),
      fieldResolver: (parent, args, context, info) => {
        const fn = (R[info.parentType.name] as Record<string, Function> | undefined)?.[info.fieldName];
        return typeof fn === 'function' ? fn(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
      },
    });
    expect(refused.errors).toBeUndefined();
    expect(refused.data).toEqual({ worker: { bootPromptServe: { refusal: 'BOOT_PROMPT_NOT_APPROVED', served: null } } });
  });
});

describe('#2708 the seam catches only the typed serve refusals', () => {
  it('a fault that is not a serve refusal (a dropped connection) propagates; it is never reported as a refusal', async () => {
    const { previewServedBootPrompt } = await import('../../../lib/bootPrompt/serve.js');
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'agent') return { findUnique: async () => { throw new Error('connection terminated'); } };
        return (target as any)[prop];
      },
    }) as typeof db;
    await expect(previewServedBootPrompt(failing, { surface: 'bind', appId: null, agent: { id: agent.id, name: 'Role' }, workerId: null }))
      .rejects.toThrow('connection terminated');
  });
});
