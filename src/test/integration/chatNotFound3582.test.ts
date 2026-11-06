/** #3582: missing and concealed chat selectors have one typed HTTP refusal on every chat door. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey } from '../../middleware/auth.js';
import { withChatRootLock } from '../../lib/chatRoot.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let server: Server;
let base: string;
let owner: string, outsider: string, otherOwner: string;
let keys: Record<string, string>;
let memoryId: string, nodeId: string;
const chatId = 'chats:202611060800-chat3582';
const absent = 'chats:202611060800-absent3582';
const operations = [
  ['sendChatMessage', 'mutation($id:String!){sendChatMessage(chatId:$id,userMessage:"hello"){__typename}}'],
  ['processChatResponse', 'mutation($id:String!,$response:JSON!){processChatResponse(chatId:$id,toolResponse:$response){__typename}}'],
  ['saveChatSummary', 'mutation($id:String!){saveChatSummary(chatId:$id,summary:"summary")}'],
  ['updateChatTitle', 'mutation($id:String!){updateChatTitle(chatId:$id,title:"new title")}'],
  ['deleteChat', 'mutation($id:String!){deleteChat(chatId:$id)}'],
  ['chatHistory', 'query($id:String!){chatHistory(chatId:$id){__typename}}'],
] as const;
async function gql(key: string, query: string, id: string) {
  const response = await fetch(base + '/graphql', { method: 'POST', headers: {
    authorization: `Bearer ${key}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ query, variables: { id, response: {} } }) });
  expect(response.status).toBe(200);
  return await response.json() as { data?: unknown; errors?: Array<{ message: string; extensions: Record<string, unknown> }> };
}
beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(async () => {
  await cleanDb(db);
  owner = (await db.user.create({ data: { handle: 'owner3582', roles: ['READER'] } })).id;
  outsider = (await db.user.create({ data: { handle: 'outsider3582', roles: ['READER'] } })).id;
  otherOwner = (await db.user.create({ data: { handle: 'other3582', roles: ['READER'] } })).id;
  const org = await db.organization.create({ data: { name: 'host3582', urn: 'host3582' } });
  const otherOrg = await db.organization.create({ data: { name: 'other3582', urn: 'other3582' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: owner, role: 'OWNER' },
    { organizationId: otherOrg.id, userId: otherOwner, role: 'OWNER' },
  ] });
  memoryId = (await db.memory.create({ data: { name: 'host3582', urn: 'host3582:memory', class: 'knowledge', organizationId: org.id, createdBy: owner } })).id;
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId, loc: chatId, name: 'private title', nodeType: 'record', createdBy: owner, data: { conversationName: 'old title', messageCount: 0 } } })).id;
  keys = {};
  for (const id of [owner, outsider, otherOwner]) keys[id] = (await mintUserApiKey(db, { userId: id, createdBy: id, label: '3582', issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
});

for (const [name, query] of operations) describe(name, () => {
  for (const caller of ['missing', 'outsider', 'other-org owner'] as const) it('returns the same typed refusal for ' + caller, async () => {
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const user = caller === 'outsider' ? outsider : caller === 'other-org owner' ? otherOwner : owner;
    const id = caller === 'missing' ? absent : chatId;
    const result = await gql(keys[user], query, id);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].extensions).toEqual({ code: 'CHAT_NOT_FOUND' });
    expect(result.errors![0].message).toBe(`Chat "${id}" not found`);
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toEqual(before);
  });
});
it('the same fixture is a successful title write for its current owner', async () => {
  const result = await gql(keys[owner], operations[3][1], chatId);
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ updateChatTitle: true });
  expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).data).toMatchObject({ title: 'new title' });
});
it('an admitted former creator retains the later write denial, not chat concealment', async () => {
  await db.orgMember.deleteMany({ where: { userId: owner } });
  const result = await gql(keys[owner], operations[3][1], chatId);
  expect(result.errors).toHaveLength(1);
  expect(result.errors![0].extensions.code).toBe('FORBIDDEN');
  expect(result.errors![0].message).not.toMatch(/not found/);
});
it('a root that vanishes after selection has the same typed not-found at the actual locked read', async () => {
  const selected = { id: nodeId, memoryId, loc: chatId };
  await db.node.delete({ where: { id: nodeId } });
  const callback = vi.fn();
  await expect(withChatRootLock(db, selected, { id: memoryId, isEncrypted: false }, callback))
    .rejects.toMatchObject({ message: `Chat "${chatId}" not found`, extensions: { code: 'CHAT_NOT_FOUND' } });
  expect(callback).not.toHaveBeenCalled();
});
