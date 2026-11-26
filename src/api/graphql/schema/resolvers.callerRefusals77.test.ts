/**
 * Write door target refusals (hadron-internal#77).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Target = {
  mem: string; memId: string; a: string; aId: string; b: string; edge: string; rev: string;
  log: string; q: string; newUrn: string; app: string; agent: string;
};
type Args = (t: Target) => Record<string, unknown>;

let real: Target;
let miss: Target;
let orgId: string;
let ownerId: string;
let outsiderId: string;
let appId: string;
let agentId: string;
let foreignAppId: string;

const mutations = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => unknown>;

/** Doors that name one target, with every spelling of it. */
const doors: Array<[string, string, Args]> = [];
const door = (name: string, spelling: string, args: Args) => doors.push([name, spelling, args]);

for (const k of ['mem', 'memId'] as const) {
  door('createChannel', k, t => ({ input: { memoryRef: t[k], loc: 'ch', name: 'c' } }));
  door('updateMemory', k, t => ({ ref: t[k], name: 'n' }));
  for (const n of ['retryFailedEmbeddings', 'encryptMemory', 'approveMemoryNodes', 'mintMemoryNodes', 'mintSpecCorpus']) door(n, k, t => ({ memoryRef: t[k] }));
  for (const n of ['deleteMemory', 'syncMemory', 'pushMemoryToGit']) door(n, k, t => ({ ref: t[k] }));
  door('cloneMemory', k, t => ({ ref: t[k], targetUrn: 'hrn:mem:ref77:copy' }));
  door('setMemorySourceToken', k, t => ({ ref: t[k], token: 'x' }));
  door('createMemorySubscription', k, t => ({ memoryRef: t[k], orgRef: orgId, role: 'READER' }));
  door('updateMemorySubscription', k, t => ({ memoryRef: t[k], orgRef: orgId, role: 'READER' }));
  door('deleteMemorySubscription', k, t => ({ memoryRef: t[k], orgRef: orgId }));
  door('linkMemoryToUser', k, t => ({ memoryRef: t[k], externalUserId: 'e' }));
  door('createMemoryShare', k, t => ({ memoryRef: t[k], granteeRef: ownerId, role: 'reader' }));
  door('updateMemoryShareRole', k, t => ({ memoryRef: t[k], granteeRef: ownerId, role: 'reader' }));
  door('deleteMemoryShare', k, t => ({ memoryRef: t[k], granteeRef: ownerId }));
  door('reserveSpecCitation', k, t => ({ memoryRef: t[k], loc: 'cor:x:010' }));
  door('allocateSpecNode', k, t => ({ memoryRef: t[k], parentLoc: 'cor:x' }));
  door('renumberSpec', k, t => ({ memoryRef: t[k], fromLoc: 'a', toLoc: 'a2' }));
  door('searchReplaceInSpecNodes', k, t => ({ input: { memoryRef: t[k], nodeRefs: [t.aId], oldText: 'c', newText: 'd', fields: ['content'], dryRun: true } }));
  door('attachMemoryToApp', k, t => ({ memoryRef: t[k], appRef: appId, agentRef: agentId }));
  door('addMemoryToAgent', k, t => ({ memoryRef: t[k], agentRef: agentId }));
  door('removeMemoryFromAgent', k, t => ({ memoryRef: t[k], agentRef: agentId }));
  door('transferMemoryOwnership', k, t => ({ memoryRef: t[k], orgRef: orgId }));
  door('createNode', k, t => ({ input: { memoryRef: t[k], loc: 'n', name: 'n', content: 'c' } }));
  door('updateNode(memoryRef+loc)', k, t => ({ input: { memoryRef: t[k], loc: 'a', content: 'd' } }));
  door('searchReplaceInNodes(memoryRefs)', k, t => ({ input: { memoryRefs: [t[k]], oldText: 'c', newText: 'd', fields: ['CONTENT'] } }));
  door('createObject', k, t => ({ memoryRef: t[k], type: 'x', fields: {} }));
  for (const n of ['createSpecNode', 'createReviewNode', 'createTaskNode']) door(n, k, t => ({ input: { memoryRef: t[k], loc: 'n', name: 'n', content: 'c' } }));
  door('createQuestionLog', k, t => ({ memoryRef: t[k], loc: 'l2', name: 'L', defaultDeciders: [ownerId] }));
  door('replaceSubtree', k, t => ({ ownerRepo: 'a/b', memoryId: t[k], nodes: [], edges: [] }));
  door('mergeMemories', k, t => ({ input: { source: t[k], target: real.memId } }));
}
for (const k of ['a', 'aId'] as const) {
  door('updateNode', k, t => ({ input: { ref: t[k], content: 'd' } }));
  door('updateNodeData', k, t => ({ nodeRef: t[k], data: { x: 1 } }));
  door('updateNodeProperties', k, t => ({ nodeRef: t[k], properties: { x: 1 } }));
  door('searchReplaceInNodes(nodeRefs)', k, t => ({ input: { nodeRefs: [t[k]], oldText: 'c', newText: 'd', fields: ['CONTENT'] } }));
  door('deleteNode', k, t => ({ nodeRef: t[k] }));
  for (const n of ['updateSpecNode', 'updateReviewNode', 'updateTaskNode']) door(n, k, t => ({ input: { ref: t[k], content: 'd' } }));
  door('approveNode', k, t => ({ nodeRef: t[k] }));
  door('recordNodeContentValidationReport', k, t => ({ nodeRef: t[k], nodeRevision: 1, validationTaskRef: t.b, validationTaskRevision: 1, outcome: 'PASS' }));
  door('runTask', k, t => ({ nodeRef: t[k] }));
  door('runTask(appRef)', k, t => ({ nodeRef: t[k], appRef: t.app }));
  door('createEdge(source)', k, t => ({ sourceRef: t[k], targetRef: t.b, name: 'r2' }));
  door('planNodeMove', k, t => ({ sourceRef: t[k], targetUrn: t.newUrn }));
  door('moveNode', k, t => ({ sourceRef: t[k], targetUrn: t.newUrn }));
  door('cloneNode', k, t => ({ sourceRef: t[k], targetUrn: t.newUrn }));
  door('mergeNodes', k, t => ({ input: { source: t[k], target: t.b } }));
  door('clearNodeHistory', k, t => ({ nodeRef: t[k] }));
  door('exportNodeToGoogleDoc', k, t => ({ nodeRef: t[k], connectionRef: generateId() }));
  door('updateObject', k, t => ({ ref: t[k], fields: {} }));
  door('deleteObject', k, t => ({ ref: t[k] }));
  door('extractParentNodeToMemory', k, t => ({ parentRef: t[k], targetUrn: 'hrn:mem:ref77:ex' }));
  door('createEdge(target)', k, t => ({ sourceRef: t.b, targetRef: t[k], name: 'r3' }));
  door('retireSpec', k, t => ({ input: { ref: t[k], form: 'RESCIND', reason: 'r', summary: 's', expectedRevision: 1 } }));
}
door('updateEdge', 'ref', t => ({ edgeRef: t.edge, name: 'q' }));
door('deleteEdge', 'ref', t => ({ edgeRef: t.edge }));
door('restoreNodeRevision', 'ref', t => ({ nodeRevRef: t.rev }));
door('deleteNodeRevision', 'ref', t => ({ nodeRevRef: t.rev }));
door('updateNodeRevision', 'ref', t => ({ nodeRevRef: t.rev, revLabel: 'x' }));
door('setQuestionLogDeciders', 'ref', t => ({ logRef: t.log, defaultDeciders: [ownerId], expectedRevision: 1, reason: 'r' }));
door('askQuestion', 'ref', t => ({ logRef: t.log, input: { title: 'T?' } }));
door('amendQuestion', 'ref', t => ({ ref: t.q, input: {}, expectedRevision: 1, reason: 'r' }));
door('withdrawQuestion', 'ref', t => ({ ref: t.q, expectedRevision: 1, reason: 'r' }));
door('answerQuestion', 'ref', t => ({ ref: t.q, input: { text: 'y' }, expectedRevision: 1 }));
door('retractQuestionAnswer', 'ref', t => ({ ref: t.q, expectedRevision: 1, reason: 'r' }));
door('purgeUnansweredQuestion', 'ref', t => ({ ref: t.q, reason: 'r' }));

for (const verb of ['createNode', 'updateNode']) {
  door(verb, 'install', t => ({ input: { install: { app: t.app, agent: t.agent }, loc: 'n', name: 'n', content: 'c' } }));
}

beforeAll(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ref77', urn: 'ref77' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'ref77-other', urn: 'ref77-other' } });
  orgId = org.id;
  const user = async (handle: string) => (await db.user.create({ data: { id: generateId(), name: handle, handle, roles: ['READER'] } })).id;
  ownerId = await user('ref77-owner');
  outsiderId = await user('ref77-outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'ADMIN' } });
  const mem = await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'ref77:real', class: 'knowledge', organizationId: org.id } });
  agentId = (await db.agent.create({ data: { name: 'A', urn: 'ref77:agent', organizationId: org.id } })).id;
  appId = (await db.app.create({ data: { name: 'App', urn: 'ref77:app', organizationId: org.id } })).id;
  foreignAppId = (await db.app.create({ data: { name: 'Else', urn: 'ref77-other:app', organizationId: other.id } })).id;
  const octx: Context = { db, userId: ownerId, roles: ['ADMIN'], clientId: `user:${ownerId}` };
  const run = async (name: string, args: unknown) => (await mutations[name]!({}, args, octx)) as any;
  const node = (loc: string) => run('createNode', { input: { memoryRef: mem.id, loc, name: loc, content: 'c' } });
  const a = await node('a');
  const b = await node('b');
  await node('a:child');
  const edge = await run('createEdge', { sourceRef: a.id, targetRef: b.id, name: 'rel' });
  await run('updateNode', { input: { ref: a.id, content: 'c2' } });
  const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: a.id } });
  const log = await run('createQuestionLog', { memoryRef: mem.id, loc: 'qlog', name: 'L', defaultDeciders: [ownerId] });
  const question = await run('askQuestion', { logRef: log.row.id, input: { title: 'T?' } });
  real = {
    mem: 'hrn:mem:ref77:real', memId: mem.id, a: 'hrn:node:ref77:real:a', aId: a.id, b: 'hrn:node:ref77:real:b',
    edge: edge.id, rev: rev.id, log: log.row.id, q: question.row.id, newUrn: 'hrn:node:ref77:real:z', app: appId, agent: agentId,
  };
  miss = {
    mem: 'hrn:mem:ref77:gone', memId: generateId(), a: 'hrn:node:ref77:gone:a', aId: generateId(), b: 'hrn:node:ref77:gone:b',
    edge: generateId(), rev: generateId(), log: generateId(), q: generateId(), newUrn: 'hrn:node:ref77:gone:z', app: generateId(), agent: generateId(),
  };
});

async function answer(name: string, target: Target, args: Args, ctx: Context) {
  let text: string;
  try {
    await mutations[name]!({}, args(target), ctx);
    text = 'resolved';
  } catch (e) {
    const error = e as Error & { extensions?: Record<string, unknown> };
    text = JSON.stringify([error.name, error.message, error.extensions ?? null]);
  }
  for (const value of Object.values(target).sort((x, y) => y.length - x.length)) text = text.split(value).join('<ref>');
  return text;
}

/** These refuse a signed-out caller before any lookup. */
const refusedFirst = new Set([
  'approveMemoryNodes', 'mintMemoryNodes', 'mintSpecCorpus', 'reserveSpecCitation', 'allocateSpecNode',
  'searchReplaceInSpecNodes', 'retireSpec', 'mergeMemories', 'replaceSubtree',
  'createNode', 'updateNode', 'updateNode(memoryRef+loc)', 'updateNodeData', 'updateNodeProperties',
  'searchReplaceInNodes(memoryRefs)', 'searchReplaceInNodes(nodeRefs)', 'deleteNode', 'planNodeMove', 'moveNode',
  'mergeNodes', 'clearNodeHistory', 'createObject', 'updateObject', 'deleteObject',
  'createSpecNode', 'createReviewNode', 'createTaskNode', 'updateSpecNode', 'updateReviewNode', 'updateTaskNode',
  'approveNode', 'recordNodeContentValidationReport', 'runTask', 'runTask(appRef)',
]);

const resolverName = (label: string) => label.replace(/\(.*/, '');
const signedOut = (): Context => ({ db, roles: [], clientId: 'anonymous' });

describe('write door target refusals', () => {
  it('lists every door it claims to refuse first', () => {
    const listed = new Set(doors.map(([name]) => name));
    expect([...refusedFirst].filter((name) => !listed.has(name))).toEqual([]);
  });

  describe.each(doors)('%s (%s)', (name, _spelling, args) => {
    it('gives a signed-out caller one answer for a real and a missing target', async () => {
      const before = await db.node.findMany({ orderBy: { id: 'asc' }, select: { id: true, loc: true, revSeq: true, deletedAt: true } });
      const missing = await answer(resolverName(name), miss, args, signedOut());
      const present = await answer(resolverName(name), real, args, signedOut());
      expect(present).toBe(missing);
      expect(present).not.toBe('resolved');
      if (refusedFirst.has(name)) expect(present).toContain('"code":"UNAUTHENTICATED"');
      expect(await db.node.findMany({ orderBy: { id: 'asc' }, select: { id: true, loc: true, revSeq: true, deletedAt: true } })).toEqual(before);
    });
  });

  describe.each(doors.filter(([name, spelling]) => refusedFirst.has(name) && spelling !== 'install'))('%s (%s), signed in', (name, _spelling, args) => {
    it.each([
      ['another user', (): Context => ({ db, userId: outsiderId, roles: ['READER'], clientId: `user:${outsiderId}` })],
      ["another organization's App key", (): Context => ({ db, appId: foreignAppId, roles: [], clientId: `app:${foreignAppId}` })],
    ])('does not treat %s as signed out', async (_caller, ctx) => {
      for (const target of [miss, real]) {
        expect(await answer(resolverName(name), target, args, ctx())).not.toContain('"code":"UNAUTHENTICATED"');
      }
    });
  });
});

describe.each(['personal', 'private'] as const)('createNode, an App %s memory with a computable address', (memoryClass) => {
  // The address is built from a handle and an App slug alone.
  const urnFor = (handle: string) => `${handle}:ref77-club-${handle}-${memoryClass}`;

  beforeAll(async () => {
    const handle = `ref77-${memoryClass}`;
    const ownerOfIt = (await db.user.create({ data: { id: generateId(), name: handle, handle, roles: ['READER'] } })).id;
    // A real person with no such memory: the control address differs only in the handle.
    await db.user.create({ data: { id: generateId(), name: `${handle}-none`, handle: `${handle}-none`, roles: ['READER'] } });
    const club = await db.app.create({ data: { name: handle, urn: `ref77:club-${memoryClass}`, organizationId: orgId } });
    await db.appMember.create({ data: { appId: club.id, userId: ownerOfIt, role: 'member' } });
    await db.memory.create({ data: {
      id: generateId(), name: handle, urn: urnFor(handle), class: memoryClass,
      userId: ownerOfIt, ownerUserId: ownerOfIt, appId: club.id, userMemoryOfAgentId: agentId,
    } });
  });

  it('gives a signed-out caller one answer', async () => {
    const run = (handle: string) => {
      const target = { ...miss, mem: `hrn:mem:${urnFor(handle)}` };
      return answer('createNode', target, t => ({ input: { memoryRef: t.mem, loc: 'n', name: 'n', content: 'c' } }), signedOut());
    };
    const missing = await run(`ref77-${memoryClass}-none`);
    const present = await run(`ref77-${memoryClass}`);
    expect(present).toBe(missing);
    expect(present).toContain('"code":"UNAUTHENTICATED"');
  });
});
