/**
 * #2047 (S10, cor:agt:040:03/:07/:09/:10) — the BIND surface: an unserveable boot prompt refuses the bind and rolls it
 * back whole, an approved one is served as-is and recorded in the bind's transaction, the retired columns are not read,
 * and an open session finishes under the revision it was bound with. #2712 retired the serving switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt, describeServedWorker } from './resolvers.worker.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let org: any, app: any, agent: any, admin: any, worker: any, memoryId: string;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const bind = () => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true, llmModel: 'm-1' } }, ctx());
const records = () => db.servedPrompt.findMany({ orderBy: { servedAt: 'asc' } });

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function compiled(content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId().slice(0, 6)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(node.id);
  return node.id as string;
}
async function approve(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
async function recompileApproved(nodeId: string, content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(nodeId);
}
const pointAgent = (id: string) => db.agent.update({ where: { id: agent.id }, data: { bootPromptNodeId: id, bootPromptUrn: `u:${id}` } });

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Serve', urn: `serve-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 92047000, githubUsername: `serve-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'tester', description: 'LEGACY {{worker.name}}' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Iris' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: `${org.urn}:sys`, organizationId: org.id } })).id;
});

describe('#2047 bind', () => {
  it('no pointer: the bind is refused BOOT_PROMPT_NOT_SET and rolled back whole (no session, no record)', async () => {
    const sessions = await db.session.count();
    expect(await code(bind())).toBe('BOOT_PROMPT_NOT_SET');
    expect(await db.session.count()).toBe(sessions);
    expect(await records()).toEqual([]);
  });

  it('an unapproved compiled node refuses the bind', async () => {
    const node = await compiled('x');
    await db.node.update({ where: { id: node }, data: { approvedRevNo: null, approvedAt: null, approvedByInfo: null, approvalHash: null } });
    await pointAgent(node);
    expect(await code(bind())).toBe('BOOT_PROMPT_NOT_APPROVED');
    expect(await records()).toEqual([]);
  });

  it('serves the approved compiled text with variables filled, never the retired prompt or override, and records it', async () => {
    const node = await compiled('Hello {{worker.name}}, a {{worker.role}} on {{session.llmModel}}.');
    await pointAgent(node);
    const session = await bind();
    const [rec] = await records();
    expect(rec).toMatchObject({ kind: 'BIND', sessionId: session.id, workerId: worker.id, appId: app.id, agentId: agent.id, pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1, provenanceRevSeq: 1 });
    expect(rec!.variables).toMatchObject({ 'worker.name': 'Iris', 'worker.role': 'tester', 'session.llmModel': 'm-1' });
    expect(rec!.provenance).toEqual([{ nodeId: 'src', revSeq: 1, hash: sha256Hex('src') }]);
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const text = (await composeWorkerPrompt(ctx({ sessionId: session.id }), w as never)).text!;
    expect(text).toContain('Hello Iris, a tester on');
    expect(text).not.toContain('LEGACY');
  });

  it('an open session finishes under the revision it was bound with; the next bind records the new one', async () => {
    const node = await compiled('v1 for {{worker.name}}');
    await pointAgent(node);
    const first = await bind();
    await recompileApproved(node, 'v2 for {{worker.name}}');
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await composeWorkerPrompt(ctx({ sessionId: first.id }), w as never)).text).toContain('v1 for Iris');
    await bind();
    const recs = await records();
    expect(recs.map((r) => r.servedRevSeq)).toEqual([1, 2]);
  });

  it('a session whose recorded revision was deleted reads the typed refusal and nothing newer', async () => {
    const node = await compiled('v1 text');
    await pointAgent(node);
    const first = await bind();
    await recompileApproved(node, 'v2 text');
    await db.nodeRevision.deleteMany({ where: { nodeId: node, revNo: 1 } });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const read = await composeWorkerPrompt(ctx({ sessionId: first.id }), w as never);
    expect(read.refusal).toBe('BOOT_PROMPT_RECORDED_REVISION_DELETED');
    expect(read.text ?? '').not.toContain('v2');
  });

  it('hadron_get_worker describes the pointer level, the served revision and the refusal a bind would get', async () => {
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await describeServedWorker(ctx(), w as never)).toContain('NOT SERVEABLE — BOOT_PROMPT_NOT_SET');
    const node = await compiled('x');
    await pointAgent(node);
    const line = await describeServedWorker(ctx(), w as never);
    expect(line).toContain(`AGENT pointer, compiled node ${node}, revision 1`);
  });

  it('a recorded session keeps the variables its bind filled: a rename after the bind does not rewrite its briefing', async () => {
    const node = await compiled('Hello {{worker.name}}.');
    await pointAgent(node);
    const first = await bind();
    await db.worker.update({ where: { id: worker.id }, data: { name: 'Renamed' } });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await composeWorkerPrompt(ctx({ sessionId: first.id }), w as never)).text).toContain('Hello Iris.');
  });

  it('an open session with no record (bound before serving was on) is not silently upgraded: no prompt, SESSION_UNRECORDED', async () => {
    // A session row bound before the switch existed carries no record; #2712 retired the switch, so make the row directly.
    const first = await db.session.create({ data: { id: generateId(), workerId: worker.id, appId: app.id, userId: admin.id } });
    const node = await compiled('current text');
    await pointAgent(node);
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const read = await composeWorkerPrompt(ctx({ sessionId: first.id }), w as never);
    expect(read.refusal).toBe('SESSION_UNRECORDED');
    expect(read.text ?? '').not.toContain('current text');
  });
});

// #2702: the converted prompts keep the legacy {{name}} / {{role}} tokens until the live-node token audit (#1772), so the
// served path binds them in the same pass as the platform variables, from the values the bind filled.
describe('#2702 served text binds the legacy {{name}} / {{role}} tokens', () => {
  const LEGACY = 'You are {{name}}, filling the {{role}} role. Sign as {{name}}.';

  it('a read with no record (what a bind would be served now) binds the worker name and role', async () => {
    await pointAgent(await compiled(LEGACY));
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const text = (await composeWorkerPrompt(ctx(), w as never)).text!;
    expect(text).toContain('You are Iris, filling the tester role. Sign as Iris.');
    expect(text).not.toMatch(/\{\{(name|role)\}\}/);
  });

  it("a recorded session's replay binds the recorded name and role, not today's", async () => {
    await pointAgent(await compiled(LEGACY));
    const session = await bind();
    await db.worker.update({ where: { id: worker.id }, data: { name: 'Renamed', role: 'renamed-role' } });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const text = (await composeWorkerPrompt(ctx({ sessionId: session.id }), w as never)).text!;
    expect(text).toContain('You are Iris, filling the tester role. Sign as Iris.');
    expect(text).not.toMatch(/\{\{(name|role)\}\}/);
  });
});
