/** #277 / cor:api:210:01: explicit nullable data clears; omitted preserves. Real registered GraphQL/MCP paths. */
import { ApolloServer } from '@apollo/server';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { createTestableMcpServer } from './server.js';
import { parseDataKey } from '../lib/crypto.js';
import { encryptNodeFieldsWithKey, decryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { revisionStateHashRefreshMarker } from '../lib/nodeRevisionSnapshot.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => sessionKeyCache.clear());
const key = parseDataKey(Buffer.alloc(32, 27).toString('base64'));
let owner: string, outsider: string, memory: { id: string; urn: string }, node: { id: string; loc: string };
const original = { keep: 1, nested: { a: 'old' } };

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  owner = (
    await db.user.create({
      data: { handle: `clear-owner-${generateId()}`, roles: ['READER'] },
    })
  ).id;
  outsider = (
    await db.user.create({
      data: { handle: `clear-other-${generateId()}`, roles: ['READER'] },
    })
  ).id;
  memory = await db.memory.create({
    data: {
      name: 'clear277',
      urn: `clear277-${generateId()}:private`,
      class: 'private',
      userId: owner,
      ownerUserId: owner,
      vectorIndexEnabled: false,
    },
  });
  node = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'probe',
      name: 'Before',
      content: 'body untouched',
      data: original,
    },
  });
});
async function encrypted() {
  await db.memory.update({
    where: { id: memory.id },
    data: { isEncrypted: true },
  });
  await db.node.update({
    where: { id: node.id },
    data: {
      ...encryptNodeFieldsWithKey({ content: 'body untouched', data: original }, key),
      revisionContentHash: revisionStateHashRefreshMarker(),
    } as never,
  });
  sessionKeyCache.set('clear277', memory.id, key);
}
async function stored(enc: boolean) {
  const r = await db.node.findUniqueOrThrow({ where: { id: node.id } });
  return enc ? decryptNodeFieldsWithKey(r, key) : r;
}
async function revisions() {
  return db.nodeRevision.count({ where: { nodeId: node.id } });
}
async function update(surface: string, patch: Record<string, unknown>, userId = owner) {
  if (surface === 'GraphQL') {
    const out = await server.executeOperation(
      {
        query: 'mutation($input:UpdateNodeInput!){updateNode(input:$input){id data content}}',
        variables: { input: { id: node.id, ...patch } },
      },
      { contextValue: { db, userId, roles: ['READER'] } },
    );
    if (out.body.kind !== 'single') throw new Error('unexpected incremental response');
    if (out.body.singleResult.errors?.length) throw new Error(out.body.singleResult.errors[0]!.message);
    return out.body.singleResult.data?.updateNode;
  }
  const client = createTestableMcpServer({
    userId,
    roles: ['READER'],
    clientId: `user:${userId}`,
  });
  // The test helper invokes callbacks directly: validate registered SDK data schema separately, too.
  if (Object.hasOwn(patch, 'data')) client.toolParamSchema('hadron_update_node', 'data').parse(patch.data);
  const text = await client.callToolText('hadron_update_node', {
    urn: emitNodeUrnV2(memory.urn, node.loc),
    ...patch,
  });
  expect(text).toContain('Node updated:');
  return text;
}
describe.each(['GraphQL', 'MCP'])('%s data replacement', (surface) => {
  describe.each([false, true])('encrypted=%s', (enc) => {
    beforeEach(async () => {
      if (enc) await encrypted();
    });
    it('explicit null clears persisted data and records one revision', async () => {
      await update(surface, { data: null });
      expect((await stored(enc)).data).toBeNull();
      expect(await revisions()).toBe(1);
      expect((await stored(enc)).content).toBe('body untouched');
    });
    it('omitting data preserves it', async () => {
      await update(surface, { name: 'Renamed' });
      expect((await stored(enc)).data).toEqual(original);
    });
    it('empty object replaces the data bag', async () => {
      await update(surface, { data: {} });
      expect((await stored(enc)).data).toEqual({});
    });
    it('object replaces rather than merges', async () => {
      await update(surface, { data: { replacement: 2 } });
      expect((await stored(enc)).data).toEqual({ replacement: 2 });
    });
    it('no write authority leaves data and history untouched', async () => {
      await expect(update(surface, { data: null }, outsider)).rejects.toBeDefined();
      expect((await stored(enc)).data).toEqual(original);
      expect(await revisions()).toBe(0);
    });
  });
});
it.each([false, true])(
  'MCP callback also clears when encrypted=%s (independent of schema acceptance)',
  async (enc) => {
    if (enc) await encrypted();
    const client = createTestableMcpServer({
      userId: owner,
      roles: ['READER'],
      clientId: `user:${owner}`,
    });
    const text = await client.callToolText('hadron_update_node', {
      urn: emitNodeUrnV2(memory.urn, node.loc),
      data: null,
    });
    expect(text).toContain('Node updated:');
    expect((await stored(enc)).data).toBeNull();
    expect(await revisions()).toBe(1);
  },
);
it.each(['GraphQL', 'MCP'])(
  '%s locked encrypted memory refuses a clear without side effects',
  async (surface) => {
    await encrypted();
    sessionKeyCache.clear();
    await expect(update(surface, { data: null })).rejects.toBeDefined();
    expect((await stored(true)).data).toEqual(original);
    expect(await revisions()).toBe(0);
  },
);
