/**
 * #4039 (gate B3/B4; cor:cht:020:02): the save-time refusal `INVALID_ENTRY_CONDITION` on every covered GraphQL writer
 * (createNode, updateNode, updateNodeData, which is also the CLI's `hadron node update` door). A conversation node
 * (`conversations:<name>`, any memory) whose `data.entryCondition` is invalid, or reads a variable with no value at chat
 * start (`chat.*`, `message.data.*`), never lands; the node is unchanged after every refusal.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
let memory: { id: string };
let admin: { id: string };
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

const CHAT_VAR = { '==': [{ var: 'chat.message_count' }, 0] };
const MSG_VAR = { '==': [{ var: 'message.data.x' }, 1] };
const GOOD = { '>': [{ var: 'now()' }, { var: 'memory.since' }] };

async function code(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: any) => x);
  return e ? { code: e.extensions?.code ?? e.message, reason: e.extensions?.reason, detail: e.extensions?.detail, keys: Object.keys(e.extensions ?? {}) } : null;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-4039s', urn: 'org-4039s' } });
  admin = await db.user.create({ data: { githubId: 40395, githubUsername: 'admin-4039s', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await M.createMemory({}, { orgId: org.id, name: 'mem-4039s' }, ctx());
});

const conv = (data: unknown, loc = 'conversations:welcome') => ({ loc, name: 'welcome', memoryId: memory.id, data });
const existing = (data: unknown = { stageOrder: ['s1'] }) =>
  db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'conversations:welcome', name: 'welcome', data: data as never } });

describe('#4039 INVALID_ENTRY_CONDITION on the GraphQL writers', () => {
  it('9 createNode: a chat.* condition is refused, nothing is created; detail is {field} only (no messageId)', async () => {
    const r = await code(M.createNode({}, { input: conv({ entryCondition: CHAT_VAR }) }, ctx()));
    expect(r).toMatchObject({ code: 'INVALID_ENTRY_CONDITION', reason: 'SCOPE_NOT_AVAILABLE_AT_START', detail: { field: 'chat.message_count' } });
    expect(r!.keys).not.toContain('messageId');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'conversations:welcome' } })).toBe(0);
  });

  it('9b createNode (Baloo P2): the scalar missing form {missing: "chat.x"} is refused like the array form', async () => {
    expect(await code(M.createNode({}, { input: conv({ entryCondition: { missing: 'chat.message_count' } }) }, ctx()))).toMatchObject({ reason: 'SCOPE_NOT_AVAILABLE_AT_START', detail: { field: 'chat.message_count' } });
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'conversations:welcome' } })).toBe(0);
  });

  it('9c createNode (Baloo D1): a computed variable path and a malformed missing_some are refused; a literal memory path still saves', async () => {
    for (const c of [{ var: { or: ['chat.message_count'] } }, { missing: [{ or: ['chat.x'] }] }, { missing_some: [1, { or: ['chat.x'] }] }]) {
      expect(await code(M.createNode({}, { input: conv({ entryCondition: c }) }, ctx()))).toMatchObject({ code: 'INVALID_ENTRY_CONDITION', reason: 'UNKNOWN_SCOPE' });
    }
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'conversations:welcome' } })).toBe(0);
    expect(await code(M.createNode({}, { input: conv({ entryCondition: { missing_some: [1, ['memory.a', 'memory.b']] } }) }, ctx()))).toBeNull();
  });

  it('9 createNode: message.data.*, an unknown scope, a disallowed operator and malformed JSON are refused with their reasons', async () => {
    expect(await code(M.createNode({}, { input: conv({ entryCondition: MSG_VAR }) }, ctx()))).toMatchObject({ reason: 'SCOPE_NOT_AVAILABLE_AT_START' });
    expect(await code(M.createNode({}, { input: conv({ entryCondition: { '==': [{ var: 'nope.x' }, 1] } }) }, ctx()))).toMatchObject({ reason: 'UNKNOWN_SCOPE' });
    expect(await code(M.createNode({}, { input: conv({ entryCondition: { eval: 'x' } }) }, ctx()))).toMatchObject({ reason: 'DISALLOWED_OPERATOR', detail: { operator: 'eval' } });
    expect(await code(M.createNode({}, { input: conv({ entryCondition: { '==': [1, 1], '!=': [1, 2] } }) }, ctx()))).toMatchObject({ reason: 'INVALID_JSONLOGIC' });
  });

  it('6 updateNode (id selector): an invalid condition is refused and the node is unchanged', async () => {
    const node = await existing();
    const r = await code(M.updateNode({}, { input: { id: node.id, data: { stageOrder: ['s1'], entryCondition: CHAT_VAR } } }, ctx()));
    expect(r).toMatchObject({ code: 'INVALID_ENTRY_CONDITION', reason: 'SCOPE_NOT_AVAILABLE_AT_START' });
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).data).toEqual({ stageOrder: ['s1'] });
  });

  it('6 updateNodeData (the CLI `hadron node update` door) merges, then refuses; the node is unchanged', async () => {
    const node = await existing();
    const r = await code(M.updateNodeData({}, { nodeRef: node.id, data: { entryCondition: CHAT_VAR } }, ctx()));
    expect(r).toMatchObject({ code: 'INVALID_ENTRY_CONDITION', reason: 'SCOPE_NOT_AVAILABLE_AT_START' });
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).data).toEqual({ stageOrder: ['s1'] });
  });

  it('CONTROL: a valid memory.* condition with now() saves; a chat.* condition on a NON-conversation node is not an entry condition', async () => {
    expect(await code(M.createNode({}, { input: conv({ entryCondition: GOOD }) }, ctx()))).toBeNull();
    expect(await code(M.createNode({}, { input: { loc: 'notes:x', name: 'x', memoryId: memory.id, data: { entryCondition: CHAT_VAR } } }, ctx()))).toBeNull();
    expect(await code(M.createNode({}, { input: { loc: 'conversations:welcome:s1', name: 's1', memoryId: memory.id, data: { entryCondition: CHAT_VAR } } }, ctx()))).toBeNull();
  });
});
