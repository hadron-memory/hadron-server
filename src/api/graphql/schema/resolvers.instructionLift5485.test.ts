/**
 * #5485 Ask 3 (hrn:node:hadronmemory.com:specs:cor:api:090:02) — asking for instructions lifts the `system` default.
 *
 * A filter that names `isRunnable: true`, or a `role` in an instruction family (task, process, boot-prompt, chatbot),
 * is an explicit ask, exactly as naming a `nodeType` is: `system` is not left out. `chat-message` and comments stay
 * out, and the memory-class SYSTEM default is not lifted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { defaultExcludedNodeTypes } from '../../../lib/retrieval/defaultNodeTypes.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
let reader: { id: string };
let sys: { id: string };
let know: { id: string };
const as = (): Context => ({ db, userId: reader.id, roles: [] });
const findNodes = (args: Record<string, unknown>) => Q.findNodes(null, args, as());
const locs = (res: { hits: Array<{ node: { loc: string } }> }) => res.hits.map((h) => h.node.loc).sort();

const MODES: Array<[string, Record<string, unknown>]> = [
  ['filter-only', {}],
  ['keyword', { query: 'harbor', mode: 'keyword' }],
  ['regex', { query: 'harbor', mode: 'regex' }],
];

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Lift Org', urn: `lift5485-${n}.example` } });
  reader = await db.user.create({ data: { githubId: 548501, githubUsername: 'lift-5485', handle: 'lift-5485', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  sys = await db.memory.create({ data: { id: generateId(), class: 'system', organizationId: org.id, name: 'bot system', urn: `${org.urn}:bot-system` } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'bot', urn: `${org.urn}:bot`, visibility: 'ORGANIZATION', systemMemoryId: sys.id } });
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'member' } });
  know = await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, name: 'kb', urn: `${org.urn}:kb` } });
  const base = { abstract: 'harbor plan', content: 'harbor plan text' };
  await db.node.createMany({
    data: [
      { ...base, id: generateId(), memoryId: sys.id, loc: 'tasks:t1', name: 'harbor task', nodeType: 'system', isRunnable: true, role: 'task' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'tasks:t2', name: 'harbor role task', nodeType: 'system', isRunnable: true, role: 'task.role' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'processes:p1', name: 'harbor process', nodeType: 'system', role: 'process' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'processes:p2', name: 'harbor sub process', nodeType: 'system', role: 'process.release' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'boot:source', name: 'harbor source', nodeType: 'system', role: 'boot-prompt.source' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'conversations:c', name: 'harbor conversation', nodeType: 'system', role: 'chatbot.conversation' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'plain-system', name: 'harbor plain system', nodeType: 'system', role: 'notes' },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'msg:1', name: 'harbor msg', nodeType: 'chat-message', seq: 1, isRunnable: true },
      { ...base, id: generateId(), memoryId: sys.id, loc: 'docs', name: 'harbor docs', nodeType: 'info' },
      { ...base, id: generateId(), memoryId: know.id, loc: 'kb-task', name: 'harbor kb task', nodeType: 'system', isRunnable: true, role: 'task' },
      { ...base, id: generateId(), memoryId: know.id, loc: 'kb-doc', name: 'harbor kb doc', nodeType: 'info' },
    ],
  });
});

describe('#5485 the lift is decided in the one helper', () => {
  it('defaultExcludedNodeTypes lifts system for isRunnable true and for an instruction role, and never chat-message', () => {
    expect([...defaultExcludedNodeTypes({})]).toEqual(['system', 'chat-message']);
    expect([...defaultExcludedNodeTypes({ isRunnable: true } as never)]).toEqual(['chat-message']);
    for (const role of ['task', 'task.role', 'process', 'process.x', 'boot-prompt', 'boot-prompt.rule', 'chatbot', 'chatbot.stage']) {
      expect([...defaultExcludedNodeTypes({ role } as never)], role).toEqual(['chat-message']);
    }
    for (const filter of [{ isRunnable: false }, { isRunnable: null }, { role: 'notes' }, { role: 'tasks' }, { role: 'processor' }, { role: 'review' }]) {
      expect([...defaultExcludedNodeTypes(filter as never)], JSON.stringify(filter)).toEqual(['system', 'chat-message']);
    }
  });
});

describe('#5485 findNodes: asking for instructions is an explicit ask', () => {
  it.each(MODES)('%s: isRunnable true returns the system tasks, not the chat-message', async (_m, args) => {
    const none = await findNodes({ ...args, filter: { memoryRefs: [sys.id] }, limit: 50 });
    expect(locs(none)).toEqual(['docs']);
    const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], isRunnable: true }, limit: 50 });
    expect(locs(res)).toEqual(['tasks:t1', 'tasks:t2']);
  });

  it.each(MODES)('%s: role task returns the system tasks, the family included', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], role: 'task' }, limit: 50 });
    expect(locs(res)).toEqual(['tasks:t1', 'tasks:t2']);
  });

  it.each(MODES)('%s: role process returns the system processes', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], role: 'process' }, limit: 50 });
    expect(locs(res)).toEqual(['processes:p1', 'processes:p2']);
  });

  it.each(MODES)('%s: role boot-prompt and role chatbot ask too', async (_m, args) => {
    expect(locs(await findNodes({ ...args, filter: { memoryRefs: [sys.id], role: 'boot-prompt' }, limit: 50 }))).toEqual(['boot:source']);
    expect(locs(await findNodes({ ...args, filter: { memoryRefs: [sys.id], role: 'chatbot' }, limit: 50 }))).toEqual(['conversations:c']);
  });

  it.each(MODES)('%s: a role outside the instruction families and isRunnable false do not ask', async (_m, args) => {
    expect(locs(await findNodes({ ...args, filter: { memoryRefs: [sys.id], role: 'notes' }, limit: 50 }))).toEqual([]);
    expect(locs(await findNodes({ ...args, filter: { memoryRefs: [sys.id], isRunnable: false }, limit: 50 }))).toEqual(['docs']);
  });

  it.each(MODES)('%s: with no memory named, a system-class memory stays out; chat-message stays out everywhere', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { isRunnable: true }, limit: 200 });
    const hits = res.hits as Array<{ node: { loc: string; memoryId: string } }>;
    expect(hits.filter((h) => h.node.memoryId === sys.id)).toEqual([]);
    expect(hits.filter((h) => h.node.memoryId === know.id).map((h) => h.node.loc)).toEqual(['kb-task']);
    expect(hits.map((h) => h.node.loc)).not.toContain('msg:1');
  });

  it.each(MODES)('%s: an explicit nodeType still decides alone', async (_m, args) => {
    const res = await findNodes({ ...args, filter: { memoryRefs: [sys.id], isRunnable: true, nodeType: 'info' }, limit: 50 });
    expect(locs(res)).toEqual([]);
  });
});
