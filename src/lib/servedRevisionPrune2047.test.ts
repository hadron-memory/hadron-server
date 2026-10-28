/**
 * #2047 PR-C (cor:dmo:150:07, cor:dmo:060:04): automatic cap-pruning never removes the compiled revision an OPEN
 * session or an unfinished run was served. Once the owner has ended it is an ordinary revision again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { revisionsExemptFromPruning } from './nodeRevisionSnapshot.js';
import { recordServedPrompt } from './bootPrompt/serve.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memory: { id: string };
let orgId: string;
let appId: string;
let agentId: string;
let workerId: string;

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const mk = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: 'v1' },
});
const edit = (id: string, content: string) => resolvers.Mutation.updateNode(null, { input: { id, content } }, as());
const editMany = async (id: string, n: number) => { for (let i = 0; i < n; i++) await edit(id, `more ${i}-${generateId()}`); };
const retained = async (nodeId: string) =>
  (await db.nodeRevision.findMany({ where: { nodeId }, select: { revNo: true } })).map((r) => r.revNo as number).sort((a, b) => a - b);

const served = { pointerLevel: 'AGENT' as const, provenanceRevSeq: 1, compiledContentHash: 'h' };
const session = async (endedAt: Date | null = null) =>
  (await db.session.create({ data: { id: generateId(), appId, agentId, workerId, type: 'DEVELOPER', endedAt } as never })).id;
const run = async (status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED') =>
  (await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status } as never })).id;
const bindOf = (sessionId: string, nodeId: string, rev: number) =>
  db.servedPrompt.create({ data: { id: generateId(), kind: 'BIND', sessionId, workerId, appId, agentId, compiledNodeId: nodeId, servedRevSeq: rev, ...served } as never });
const runOf = (runId: string, nodeId: string, rev: number) =>
  db.servedPrompt.create({ data: { id: generateId(), kind: 'RUN', runId, appId, agentId, compiledNodeId: nodeId, servedRevSeq: rev, ...served } as never });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Served Org', urn: 'served.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 204701, githubUsername: 'served-admin', handle: 'served-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'served-prune' }, as());
  await db.memory.update({ where: { id: memory.id }, data: { maxRevCount: 2 } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
  workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
});

describe('served compiled revision survives cap-pruning while its owner is open (#2047 PR-C)', () => {
  it('control: with no record the oldest revision prunes past the cap', async () => {
    const n = await mk('s:0');
    await editMany(n.id, 6);
    expect(await retained(n.id)).not.toContain(1);
  });

  it('keeps the revision an open session was bound to, and still prunes the others', async () => {
    const n = await mk('s:1');
    await bindOf(await session(), n.id, 1); // rev 1 is the live revision when it is served
    await editMany(n.id, 6);
    const kept = await retained(n.id);
    expect(kept).toContain(1);
    expect(kept).not.toContain(2);
    expect([...await revisionsExemptFromPruning(db, n.id, memory.id)]).toContain(1);
  });

  it.each(['PENDING', 'RUNNING'] as const)('keeps the revision a %s run was served', async (status) => {
    const n = await mk(`s:run:${status}`);
    await runOf(await run(status), n.id, 1);
    await editMany(n.id, 6);
    expect(await retained(n.id)).toContain(1);
  });

  it('a session that ended releases it: the next prune removes the revision', async () => {
    const n = await mk('s:2');
    const sessionId = await session();
    await bindOf(sessionId, n.id, 1);
    await editMany(n.id, 4);
    expect(await retained(n.id)).toContain(1);
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    await editMany(n.id, 1);
    expect(await retained(n.id)).not.toContain(1);
  });

  it('a session already ended when the history is pruned keeps nothing', async () => {
    const n = await mk('s:3');
    await bindOf(await session(new Date()), n.id, 1);
    await editMany(n.id, 6);
    expect(await retained(n.id)).not.toContain(1);
  });

  it.each(['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] as const)('a %s run keeps nothing', async (status) => {
    const n = await mk(`s:done:${status}`);
    await runOf(await run(status), n.id, 1);
    await editMany(n.id, 6);
    expect(await retained(n.id)).not.toContain(1);
  });

  it("a record on another node, or a chat record, retains nothing of this node", async () => {
    const n = await mk('s:4');
    const other = await mk('s:5');
    await bindOf(await session(), other.id, 1);
    const chatNode = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'chats:one', name: 'chat', ownerRepo: 'r' } as never });
    await db.servedPrompt.create({
      data: { id: generateId(), kind: 'CHAT', chatId: chatNode.id, appId, agentId, compiledNodeId: n.id, servedRevSeq: 1, ...served } as never,
    });
    await editMany(n.id, 6);
    expect(await retained(n.id)).not.toContain(1);
  });

  it('keeps every distinct revision its open owners were served', async () => {
    const n = await mk('s:6');
    await bindOf(await session(), n.id, 1);
    await editMany(n.id, 2); // live is now rev 3; rev 2 is history
    await runOf(await run('RUNNING'), n.id, 3);
    await editMany(n.id, 6);
    const kept = await retained(n.id);
    expect(kept).toEqual(expect.arrayContaining([1, 3]));
  });
});

describe('a record and a prune that overlap (#2047 PR-C, two connections)', () => {
  it('a prune started while a bind is still recording waits for it, then keeps the served revision', async () => {
    const n = await mk('s:race');
    await editMany(n.id, 4); // retained [3, 4], live 5: the next edit prunes rev 3
    expect(await retained(n.id)).toEqual([3, 4]);
    const sessionId = await session();
    let editDone = false;
    let editing: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await recordServedPrompt(
        tx,
        { kind: 'BIND', sessionId, appId, agentId, workerId },
        { ...served, compiledNodeId: n.id, servedRevSeq: 3, provenance: [], content: 'x' } as never,
        {},
      );
      editing = edit(n.id, 'racing').then(() => { editDone = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(editDone).toBe(false); // the edit (and its prune) is parked behind the recording transaction
    });
    await editing;
    expect(await retained(n.id)).toContain(3);
  });
});
