/** #2122: the documented lock/unlock ID form preserves the existing key and owner gates. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { recordUrnRename } from '../lib/urnAlias.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const PASS = 'synthetic-key2122-passphrase';
const URN = 'key2122.example:vault';
const FULL_URN = 'hrn:mem:key2122.example:vault';
let ownerId: string;
let strangerId: string;
let memoryId: string;
let orgId: string;
const auth = (userId: string): AuthContext => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const mcp = (userId = ownerId, sessionId = 'key2122-a') => createTestableMcpServer(auth(userId), { sessionId });
const read = (server: ReturnType<typeof mcp>) => server.callToolText('hadron_get_node', { urn: 'hrn:node:key2122.example:vault:secret' });

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { name: 'Key ID fixture', urn: 'key2122.example' } });
  orgId = org.id;
  ownerId = (await db.user.create({ data: { githubId: 212201, roles: ['ADMIN'] } })).id;
  strangerId = (await db.user.create({ data: { githubId: 212202, roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'ADMIN' } });
  memoryId = generateId();
  await db.memory.create({ data: { id: memoryId, organizationId: orgId, name: 'Vault', urn: URN, class: 'private', userId: ownerId } });
  await db.node.create({ data: { memoryId, loc: 'secret', name: 'Secret', content: 'key2122 plaintext' } });
  await resolvers.Mutation.encryptMemory({}, { memoryId, passphrase: PASS }, { db, roles: ['ADMIN'], userId: ownerId } as Context);
});
afterEach(() => sessionKeyCache.clear());

describe('#2122 lock/unlock documented memory IDs', () => {
  it('owner unlocks by 32-hex ID, names the stored URN and reads plaintext', async () => {
    const server = mcp();
    expect(memoryId).toMatch(/^[a-f0-9]{32}$/);
    const out = await server.callToolText('hadron_unlock_memory', { memoryUrn: memoryId, passphrase: PASS });
    expect(out).toContain(`Memory unlocked for this session: ${URN}.`);
    expect(await read(server)).toContain('key2122 plaintext');
  });

  it('owner locks by ID after a URN unlock, dropping the actual cached key', async () => {
    const server = mcp();
    expect(await server.callToolText('hadron_unlock_memory', { memoryUrn: FULL_URN, passphrase: PASS })).toContain('unlocked');
    expect(await server.callToolText('hadron_lock_memory', { memoryUrn: memoryId })).toBe(`Memory locked for this session: ${memoryId}.`);
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
    expect(await read(server)).toContain('Locked: encrypted memory');
  });

  it.each(['hadron_unlock_memory', 'hadron_lock_memory'])('%s preserves exact missing text for non-owner, missing and deleted IDs/URNs', async (tool) => {
    const foreign = mcp(strangerId);
    const call = (server: ReturnType<typeof mcp>, input: string) => server.callToolText(tool, { memoryUrn: input, ...(tool === 'hadron_unlock_memory' ? { passphrase: PASS } : {}) });
    for (const input of [memoryId, FULL_URN, generateId(), 'hrn:mem:key2122.example:absent']) {
      expect(await call(foreign, input)).toBe(`Memory "${input}" not found.`);
    }
    await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    for (const input of [memoryId, FULL_URN]) {
      expect(await call(mcp(), input)).toBe(`Memory "${input}" not found.`);
    }
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it('an owned unencrypted memory by ID has the same not-encrypted answer as its URN', async () => {
    const plain = await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'Plain', urn: 'key2122.example:plain', class: 'private', userId: ownerId } });
    const server = mcp();
    for (const input of [plain.id, 'hrn:mem:key2122.example:plain']) {
      expect(await server.callToolText('hadron_unlock_memory', { memoryUrn: input, passphrase: PASS })).toBe(`Memory "${plain.urn}" is not encrypted.`);
    }
  });

  it('wrong passphrases by ID are still refused without holding a key', async () => {
    expect(await mcp().callToolText('hadron_unlock_memory', { memoryUrn: memoryId, passphrase: 'wrong' })).toContain('Wrong passphrase');
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });

  it.each(['hadron_unlock_memory', 'hadron_lock_memory'])('%s still requires user authentication for both reference forms', async (tool) => {
    const server = createTestableMcpServer({ roles: [], clientId: 'app:synthetic-key2122' } as AuthContext, { sessionId: 'key2122-app' });
    for (const input of [memoryId, FULL_URN]) {
      expect(await server.callToolText(tool, { memoryUrn: input, ...(tool === 'hadron_unlock_memory' ? { passphrase: PASS } : {}) })).toBe(`${tool} requires a user-authenticated MCP connection.`);
    }
  });

  it.each(['legacy-column', 'rename-map'])('keeps the existing %s alias arm for unlock and lock', async (kind) => {
    const old = `key2122.example:${kind}`;
    if (kind === 'legacy-column') {
      await db.memory.update({ where: { id: memoryId }, data: { legacyUrn: old } });
    } else {
      await recordUrnRename(db, { entityType: 'MEMORY', entityId: memoryId, oldUrn: old, newUrn: URN });
    }
    const input = `hrn:mem:key2122.example:${kind}`;
    const server = mcp();
    expect(await server.callToolText('hadron_unlock_memory', { memoryUrn: input, passphrase: PASS })).toContain(`Memory unlocked for this session: ${URN}.`);
    expect(await server.callToolText('hadron_lock_memory', { memoryUrn: input })).toBe(`Memory locked for this session: ${input}.`);
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });
});
