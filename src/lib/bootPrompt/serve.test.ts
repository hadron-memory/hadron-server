/**
 * #2047 (S10, cor:agt:040:07/:09/:10) — the serve resolver: serve order replaces (never appends), the newest APPROVED
 * revision is served as approved (a newer unapproved edit neither serves nor refuses), the provenance is the served
 * revision's own, and every refusal is the one typed list.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { computeApprovalHash } from '../approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../bootCompile/provenance.js';
import { resolveServedBootPrompt } from './serve.js';

let orgId: string;
let memoryId: string;
let agentId: string;
let appId: string;
let workerId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'sv-org', urn: 'sv-org' } });
  orgId = org.id;
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'sv-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'sv-org:ada', organizationId: orgId, systemMemoryId: memoryId } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'sv-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
});

const prov = (hash: string): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src-node', revNo: 1, hash, selection: { rev: null, approved: true, signed: false } }],
});

/** A compiled node at revision 1 holding `content`, with its compile row. Approved when `approve`. */
async function compiled(loc: string, content: string, approve = true) {
  const node = await withCompileWrite(() => db.node.create({
    data: { id: generateId(), memoryId, loc, name: loc, content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
  }));
  await db.compiledPromptRevision.create({
    data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov(sha256Hex('src')) as never, occurrenceCount: 1 },
  });
  if (approve) await approveLive(node.id);
  return node.id;
}
async function approveLive(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({
    where: { id: nodeId },
    data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 'test', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) },
  });
}
/** A newer, UNAPPROVED compile revision (the old one kept as a history row). */
async function recompile(nodeId: string, content: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: {
      nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [],
      approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash,
    } as never,
  });
  await withCompileWrite(() => db.node.update({
    where: { id: nodeId },
    data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 },
  }));
  await db.compiledPromptRevision.create({
    data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov(sha256Hex('src2')) as never, occurrenceCount: 1 },
  });
}
const point = {
  agent: (id: string) => db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: id, bootPromptUrn: `sv-org:sys:${id}` } }),
  install: (id: string) => db.appAgent.update({ where: { appId_agentId: { appId, agentId } }, data: { bootPromptNodeId: id, bootPromptUrn: `sv-org:sys:${id}` } }),
  worker: (id: string) => db.worker.update({ where: { id: workerId }, data: { bootPromptNodeId: id, bootPromptUrn: `sv-org:sys:${id}` } }),
};
const serve = (surface: 'bind' | 'chat' | 'run' = 'bind', withWorker = true) =>
  resolveServedBootPrompt(db, { surface, appId, agent: { id: agentId, name: 'Ada' }, workerId: withWorker ? workerId : null });
const code = async (p: Promise<unknown>) => {
  try { await p; return 'SERVED'; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message; }
};

describe('#2047 serve order (cor:agt:040:07)', () => {
  it('worker pointer beats install pointer beats Agent pointer, and the higher REPLACES (no appended text)', async () => {
    const a = await compiled('a', 'AGENT text');
    const i = await compiled('i', 'INSTALL text');
    const w = await compiled('w', 'WORKER text');
    await point.agent(a);
    expect(await serve()).toMatchObject({ pointerLevel: 'AGENT', content: 'AGENT text', compiledNodeId: a });
    await point.install(i);
    expect(await serve()).toMatchObject({ pointerLevel: 'APP_AGENT', content: 'INSTALL text' });
    await point.worker(w);
    const served = await serve();
    expect(served).toMatchObject({ pointerLevel: 'WORKER', content: 'WORKER text', compiledNodeId: w });
    expect(served.content).not.toContain('INSTALL');
  });

  it('a chat or an agent-only run (no worker) ignores the worker pointer', async () => {
    await point.agent(await compiled('a', 'AGENT text'));
    await point.worker(await compiled('w', 'WORKER text'));
    expect(await serve('chat', false)).toMatchObject({ pointerLevel: 'AGENT', content: 'AGENT text' });
  });
});

describe('#2047 refusals (cor:agt:040:10) — same code on every surface', () => {
  it('no pointer anywhere: NOT_SET', async () => {
    for (const s of ['bind', 'chat', 'run'] as const) expect(await code(serve(s))).toBe('BOOT_PROMPT_NOT_SET');
  });

  it('an unapproved compiled node refuses bind, chat and run alike', async () => {
    await point.agent(await compiled('a', 'x', false));
    for (const s of ['bind', 'chat', 'run'] as const) expect(await code(serve(s))).toBe('BOOT_PROMPT_NOT_APPROVED');
  });

  it('a set pointer whose node was soft-deleted is TARGET_DELETED, never a fall-through to a lower level', async () => {
    const lower = await compiled('lower', 'LOWER');
    const high = await compiled('high', 'HIGH');
    await point.agent(lower);
    await point.worker(high);
    await db.node.update({ where: { id: high }, data: { deletedAt: new Date() } });
    for (const s of ['bind', 'chat', 'run'] as const) expect(await code(serve(s))).toBe('BOOT_PROMPT_TARGET_DELETED');
  });

  it('the refusal names the surface and the Agent only', async () => {
    try { await serve('chat'); } catch (e) {
      const x = (e as { extensions: Record<string, unknown> }).extensions;
      expect(x).toEqual({ code: 'BOOT_PROMPT_NOT_SET', surface: 'chat', agentName: 'Ada' });
    }
  });
});

describe('#2047 the served revision (cor:agt:040:03/:09)', () => {
  it('serves the newest APPROVED revision as approved; a newer unapproved recompile is neither served nor a refusal', async () => {
    const id = await compiled('a', 'v1 text');
    await point.agent(id);
    await recompile(id, 'v2 text');
    const served = await serve();
    expect(served).toMatchObject({ content: 'v1 text', servedRevSeq: 1, provenanceRevSeq: 1, compiledContentHash: sha256Hex('v1 text') });
    expect(served.provenance).toEqual([{ nodeId: 'src-node', revSeq: 1, hash: sha256Hex('src') }]);
  });

  it('after approving the recompile the next serve names the new revision and ITS provenance', async () => {
    const id = await compiled('a', 'v1 text');
    await point.agent(id);
    await recompile(id, 'v2 text');
    await approveLive(id);
    const served = await serve();
    expect(served).toMatchObject({ content: 'v2 text', servedRevSeq: 2, provenanceRevSeq: 2 });
    expect(served.provenance[0]!.hash).toBe(sha256Hex('src2'));
  });

  it('a metadata-only revision above the compile advances servedRevSeq but keeps the compile revision as provenance owner', async () => {
    const id = await compiled('a', 'v1 text');
    await point.agent(id);
    // Revision 2: description-only edit; the approval hash (title, abstract, content) still covers it.
    const n = await db.node.findUniqueOrThrow({ where: { id } });
    await db.nodeRevision.create({
      data: { nodeId: id, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: 1, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never,
    });
    await withCompileWrite(() => db.node.update({ where: { id }, data: { revSeq: 2, description: 'meta' } }));
    expect(await serve()).toMatchObject({ content: 'v1 text', servedRevSeq: 2, provenanceRevSeq: 1 });
  });
});

describe('#2047 review fixes on PR-B', () => {
  it('a recompile landing between selection and content read never pairs the old revision number with the new text', async () => {
    const id = await compiled('a', 'v1 text');
    await point.agent(id);
    let fired = false;
    const racing = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'node') return v;
        return new Proxy(v as typeof db.node, {
          get(nt, np, nr) {
            if (np !== 'findUnique') return Reflect.get(nt, np, nr);
            return async (args: { select?: { content?: boolean } }) => {
              if (!fired && args?.select?.content) { fired = true; await recompile(id, 'v2 UNAPPROVED'); }
              return (nt.findUnique as (a: unknown) => Promise<unknown>).call(nt, args);
            };
          },
        });
      },
    }) as typeof db;
    const served = await resolveServedBootPrompt(racing, { surface: 'bind', appId, agent: { id: agentId, name: 'Ada' }, workerId });
    expect(fired).toBe(true);
    expect(served).toMatchObject({ content: 'v1 text', servedRevSeq: 1 });
  });

  it('an install pointer set by another App is never served to this App (the App scope of the install lookup)', async () => {
    const id = await compiled('inst', 'install text');
    const otherApp = (await db.app.create({ data: { id: generateId(), name: 'Other', urn: 'sv-org:other', organizationId: orgId } })).id;
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
    await db.appAgent.create({ data: { appId: otherApp, agentId, bootPromptNodeId: id, bootPromptUrn: `sv-org:sys:${id}` } as never });
    expect(await code(serve('chat', false))).toBe('BOOT_PROMPT_NOT_SET');
  });
});

describe('#2047 PR-C: selection and cap-pruning serialize on the compiled node (two connections)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('serve first: a revision write on the node (what a prune rides on) waits for the serving transaction', async () => {
    const id = await compiled('c', 'v1 text');
    await point.agent(id);
    let writeDone = false;
    let writing: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      expect(await resolveServedBootPrompt(tx, { surface: 'bind', appId, agent: { id: agentId, name: 'Ada' }, workerId })).toMatchObject({ servedRevSeq: 1 });
      writing = db.node.update({ where: { id }, data: { revSeq: { increment: 1 } } }).then(() => { writeDone = true; });
      await sleep(400);
      expect(writeDone).toBe(false);
    });
    await writing;
    expect(writeDone).toBe(true);
  });

  it('prune first: serving started while a prune holds the node waits, then never serves the removed revision', async () => {
    const id = await compiled('c2', 'v1 text');
    await recompile(id, 'v2 UNAPPROVED'); // rev 1 (approved) is now a history row
    await point.agent(id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const pruner = db.$transaction(async (tx) => {
      await tx.node.update({ where: { id }, data: { revSeq: { increment: 1 } } }); // takes the row lock first, as a revision write does
      await tx.nodeRevision.deleteMany({ where: { nodeId: id, revNo: 1 } }); // the prune
      locked();
      await held;
    });
    await lockedP;
    let served: unknown = 'PENDING';
    const serving = db.$transaction((tx) => resolveServedBootPrompt(tx, { surface: 'bind', appId, agent: { id: agentId, name: 'Ada' }, workerId }))
      .then((r) => { served = r; }, (e) => { served = e; });
    await sleep(400);
    expect(served).toBe('PENDING'); // parked behind the prune
    release();
    await pruner;
    await serving;
    expect(served).not.toMatchObject({ servedRevSeq: 1 });
  });
});
