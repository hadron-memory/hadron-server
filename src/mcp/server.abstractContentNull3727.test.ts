/**
 * #3727 / cor:api:240 — encrypted MCP parity CONTROL for `abstract` /
 * `content`: the MCP writer already maps `enc.abstract ?? null` /
 * `enc.content ?? null`, so an explicit null clears and an omission
 * preserves. These pins hold that side of the parity while the GraphQL
 * core (the changed cell, pinned in
 * resolvers.nodeAbstractContentNull3727.test.ts) is brought to the same
 * law (cor:api:210:01). Green on main by design — a regression here would
 * break parity from the other direction.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { parseDataKey } from '../lib/crypto.js';
import { computeContentHash } from '../lib/contentHash.js';
import { encryptNodeFieldsWithKey, decryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { isCiphertext } from '../lib/crypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { revisionStateHashRefreshMarker } from '../lib/nodeRevisionSnapshot.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
const key = parseDataKey(Buffer.alloc(32, 37).toString('base64'));
let owner: string, memory: { id: string; urn: string }, node: { id: string; loc: string };
const OLD_ABSTRACT = 'old abstract worth clearing';
const OLD_CONTENT = 'body with an abstract';

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  owner = (await db.user.create({ data: { handle: `m3727-owner-${generateId()}`, roles: ['READER'] } })).id;
  memory = await db.memory.create({
    data: {
      name: 'm3727', urn: `m3727-${generateId()}:private`, class: 'private',
      userId: owner, ownerUserId: owner, vectorIndexEnabled: false, isEncrypted: true,
    },
  });
  node = await db.node.create({
    data: {
      id: generateId(), memoryId: memory.id, loc: 'probe', name: 'Before',
      ...encryptNodeFieldsWithKey({ content: OLD_CONTENT, abstract: OLD_ABSTRACT }, key),
      abstractOriginHash: computeContentHash(OLD_CONTENT),
      revisionContentHash: revisionStateHashRefreshMarker(),
    } as never,
  });
  sessionKeyCache.set('m3727', memory.id, key);
});
afterEach(() => sessionKeyCache.clear());

async function stored() {
  return decryptNodeFieldsWithKey(await db.node.findUniqueOrThrow({ where: { id: node.id } }), key);
}
async function rawAbstract() {
  return (await db.node.findUniqueOrThrow({ where: { id: node.id } })).abstract;
}
async function call(patch: Record<string, unknown>) {
  const client = createTestableMcpServer({ userId: owner, roles: ['READER'], clientId: `user:${owner}` });
  const text = await client.callToolText('hadron_update_node', { urn: emitNodeUrnV2(memory.urn, node.loc), ...patch });
  expect(text).toContain('Node updated:');
  return text;
}

describe('#3727 MCP encrypted parity control (already clears — must stay)', () => {
  it('abstract:null clears the value and the hash', async () => {
    await call({ abstract: null });
    expect((await stored()).abstract).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).abstractOriginHash).toBeNull();
    expect(await rawAbstract()).toBeNull(); // SQL NULL, no ciphertext retained
  });

  it('content:null clears content while abstract and hash are preserved', async () => {
    await call({ content: null });
    const row = await stored();
    expect(row.content).toBeNull();
    expect(row.abstract).toBe(OLD_ABSTRACT);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).abstractOriginHash).toBe(computeContentHash(OLD_CONTENT));
  });

  it('a string replaces with ciphertext at rest', async () => {
    await call({ abstract: 'fresh via mcp' });
    expect(isCiphertext((await rawAbstract())!)).toBe(true);
    expect((await stored()).abstract).toBe('fresh via mcp');
  });

  it('omission preserves both columns', async () => {
    await call({ name: 'Renamed' });
    const row = await stored();
    expect(row.abstract).toBe(OLD_ABSTRACT);
    expect(row.content).toBe(OLD_CONTENT);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).abstractOriginHash).toBe(computeContentHash(OLD_CONTENT));
  });
});
