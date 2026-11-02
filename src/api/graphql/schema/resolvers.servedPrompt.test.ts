/**
 * #2047 (S10, cor:agt:040:03) — reading the served-prompt record: who may read each owner's record, that a non-reader
 * gets an empty page or null (no existence oracle), that lists are paginated, and that provenance is ids only and paged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { pageOf } from './resolvers.servedPrompt.js';

const R = resolvers as any;
const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] });

describe('served-prompt record reads (#2047)', () => {
  let appId: string;
  let ownerU: string;
  let memberU: string;
  let outsiderU: string;
  let workerId: string;
  let sessionId: string;
  let runId: string;
  let chatNodeId: string;
  let compiledNodeId: string;
  let orgId: string;

  const user = async (tag: string) =>
    (await db.user.create({ data: { id: generateId(), githubId: Math.floor(Math.random() * 1e9), githubUsername: `sp-${tag}-${generateId().slice(0, 6)}`, roles: ['READER'] } })).id;

  beforeEach(async () => {
    await cleanDb(db);
    const { org, graph } = await createDbOrgAndGraph(db, { orgName: `spr-${generateId().slice(0, 8)}` });
    orgId = org.id;
    ownerU = await user('owner');
    memberU = await user('member');
    outsiderU = await user('out');
    await db.orgMember.create({ data: { organizationId: org.id, userId: ownerU, role: 'ADMIN' } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never });
    appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
    await db.appMember.create({ data: { appId, userId: ownerU, role: 'owner' } });
    await db.appMember.create({ data: { appId, userId: memberU, role: 'cook' } });
    workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId: agent.id, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
    sessionId = (await db.session.create({ data: { id: generateId(), appId, agentId: agent.id, workerId, type: 'DEVELOPER' } as never })).id;
    runId = (
      await db.appRun.create({
        data: { id: generateId(), organizationId: org.id, appId, agentId: agent.id, userId: memberU, triggerKind: 'MANUAL', createdBy: memberU, entryNodeUrn: 'x:y:z' } as never,
      })
    ).id;
    chatNodeId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'chats:one', name: 'chat', ownerRepo: 'r' } as never })).id;
    compiledNodeId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'boot:compiled', name: 'compiled', ownerRepo: 'r', revSeq: 3 } as never })).id;
    const base = { appId, agentId: agent.id, pointerLevel: 'AGENT', compiledNodeId, servedRevSeq: 3, provenanceRevSeq: 2, compiledContentHash: 'h' };
    await db.servedPrompt.create({ data: { ...base, kind: 'BIND', sessionId, workerId, variables: { 'worker.name': 'W' } } as never });
    await db.servedPrompt.create({ data: { ...base, kind: 'RUN', runId } as never });
    for (const ordinal of [1, 2, 3]) {
      await db.servedPrompt.create({ data: { ...base, kind: 'CHAT', chatId: chatNodeId, ordinal } as never });
    }
  });

  const bindPage = (userId: string) => R.Session.servedPrompts({ id: sessionId, appId }, {}, ctxFor(userId));
  const workerRec = (userId: string) => R.Worker.servedPrompt({ id: workerId, appId }, {}, ctxFor(userId));
  const runRec = async (userId: string) => {
    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    return R.AppRun.servedPrompt(run, {}, ctxFor(userId));
  };
  const chatPage = (userId: string, args: Record<string, unknown> = {}) => R.Chat.servedPrompts({ id: chatNodeId }, args, ctxFor(userId));

  it('a bind record is read by whoever may read the worker internals, and by no one else', async () => {
    expect((await bindPage(memberU)).total).toBe(1);
    expect((await bindPage(ownerU)).items).toHaveLength(1);
    expect(await bindPage(outsiderU)).toEqual({ items: [], total: 0 });
    expect((await workerRec(memberU))?.kind).toBe('BIND');
    expect(await workerRec(outsiderU)).toBeNull();
  });

  it('a session with no App, or an ended session for Worker.servedPrompt, reads as nothing', async () => {
    expect(await R.Session.servedPrompts({ id: sessionId, appId: null }, {}, ctxFor(ownerU))).toEqual({ items: [], total: 0 });
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    expect(await workerRec(ownerU)).toBeNull();
  });

  it('a run record is read by whoever may read the run (own run, or an org reader), not by an outsider', async () => {
    expect((await runRec(memberU))?.kind).toBe('RUN');
    expect((await runRec(ownerU))?.kind).toBe('RUN');
    expect(await runRec(outsiderU)).toBeNull();
  });

  it("a chat's records are read by whoever manages the App, never by a plain member or an outsider", async () => {
    expect((await chatPage(ownerU)).total).toBe(3);
    expect(await chatPage(memberU)).toEqual({ items: [], total: 0 });
    expect(await chatPage(outsiderU)).toEqual({ items: [], total: 0 });
  });

  it("authorizing the chat's App never returns another App's record of the same chat (#2112 local P2)", async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Other', urn: `other-${generateId().slice(0, 6)}` } });
    const agentId = (await db.servedPrompt.findFirstOrThrow({ where: { chatId: chatNodeId } })).agentId;
    await db.servedPrompt.create({
      data: { kind: 'CHAT', chatId: chatNodeId, ordinal: 4, appId: other.id, agentId, pointerLevel: 'AGENT', compiledNodeId, servedRevSeq: 3, provenanceRevSeq: 2, compiledContentHash: 'h' } as never,
    });
    const page = await chatPage(ownerU);
    expect(page.total).toBe(3);
    expect(page.items.every((r: { appId: string }) => r.appId === appId)).toBe(true);
  });

  it("a deleted App's chat records read as empty even to its manager", async () => {
    await db.app.update({ where: { id: appId }, data: { deletedAt: new Date() } });
    expect(await chatPage(ownerU)).toEqual({ items: [], total: 0 });
  });

  it('a chat with no record reads as an empty page, whoever asks', async () => {
    expect(await R.Chat.servedPrompts({ id: generateId() }, {}, ctxFor(ownerU))).toEqual({ items: [], total: 0 });
  });

  it('lists are paginated: a page, the exact total, limit 0 for the count, newest first', async () => {
    const p1 = await chatPage(ownerU, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(3);
    const p2 = await chatPage(ownerU, { limit: 2, offset: 2 });
    expect(p2.items).toHaveLength(1);
    expect((await chatPage(ownerU, { limit: 0 })).items).toEqual([]);
    expect((await chatPage(ownerU, { limit: 0 })).total).toBe(3);
    expect((await chatPage(ownerU, { limit: 99_999 })).items).toHaveLength(3);
    expect(p1.items[0].ordinal).toBeGreaterThan(p2.items[0].ordinal);
  });

  it('caps a page at 200, defaults to 50, and never goes negative (cor:api:120:04)', () => {
    expect(pageOf({})).toEqual({ take: 50, skip: 0 });
    expect(pageOf({ limit: 99_999 })).toEqual({ take: 200, skip: 0 });
    expect(pageOf({ limit: -5, offset: -9 })).toEqual({ take: 0, skip: 0 });
    expect(pageOf({ limit: 10, offset: 30 })).toEqual({ take: 10, skip: 30 });
  });

  describe('the record itself', () => {
    it('is pruned when the served revision is neither the current one nor in history', async () => {
      const rec = await db.servedPrompt.findFirstOrThrow({ where: { kind: 'RUN' } });
      expect(await R.ServedPrompt.pruned(rec, {}, ctxFor(ownerU))).toBe(false);
      await db.node.update({ where: { id: compiledNodeId }, data: { revSeq: 4 } });
      expect(await R.ServedPrompt.pruned(rec, {}, ctxFor(ownerU))).toBe(true);
      await db.nodeRevision.create({ data: { nodeId: compiledNodeId, revNo: 3, loc: 'boot:compiled', name: 'compiled', tags: [] } as never });
      expect(await R.ServedPrompt.pruned(rec, {}, ctxFor(ownerU))).toBe(false);
    });

    it('pages its provenance, ids revisions and hashes only, flagging pruned entries', async () => {
      const gone = generateId();
      const provenance = [
        { nodeId: compiledNodeId, revSeq: 3, hash: 'a' },
        { nodeId: gone, revSeq: 1, hash: 'b' },
        { nodeId: gone, revSeq: 2, hash: 'c' },
      ];
      const rec = { ...(await db.servedPrompt.findFirstOrThrow({ where: { kind: 'RUN' } })), provenance };
      const first = await R.ServedPrompt.provenance(rec, { limit: 2 }, ctxFor(ownerU));
      expect(first.total).toBe(3);
      expect(first.items).toEqual([
        { nodeId: compiledNodeId, revSeq: 3, hash: 'a', pruned: false },
        { nodeId: gone, revSeq: 1, hash: 'b', pruned: true },
      ]);
      const rest = await R.ServedPrompt.provenance(rec, { limit: 2, offset: 2 }, ctxFor(ownerU));
      expect(rest.items).toHaveLength(1);
      for (const item of [...first.items, ...rest.items]) {
        expect(Object.keys(item).sort()).toEqual(['hash', 'nodeId', 'pruned', 'revSeq']);
      }
    });
  });
});
