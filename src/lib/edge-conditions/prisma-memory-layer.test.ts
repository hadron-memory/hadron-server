/**
 * Integration test for the Prisma memory-layer adapter (US4).
 * Runs against the real DB. Verifies:
 *   - plaintext memory: parent-chain walk, deepest wins
 *   - encrypted memory + active session key: data is decrypted in place
 *   - encrypted memory + no session key: every read returns
 *     key_unavailable, so the evaluator can surface MEMORY_ENCRYPTED_NO_KEY
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { buildPrismaMemoryLayer } from './prisma-memory-layer.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { encryptNodeFieldsWithKey } from '../nodeCrypto.js';
import { generateDataKey, parseDataKey } from '../crypto.js';
import type { InputJsonValue } from '../../generated/prisma/runtime/library.js';

let org: { id: string; urn: string };

async function makeMemory(name: string, isEncrypted: boolean) {
  return db.memory.create({
    data: {
      class: 'knowledge',
      organizationId: org.id,
      urn: `${org.urn}:${name}`,
      name,
      visibility: 'PRIVATE',
      isEncrypted,
    },
  });
}

async function seedNode(memoryId: string, loc: string, data: Record<string, unknown>) {
  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      name: loc,
      nodeType: 'info',
      data: data as InputJsonValue,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'pml', urn: 'pml' },
  });
});

describe('buildPrismaMemoryLayer / plaintext memory', () => {
  it('reads a value from `loc: data`', async () => {
    const mem = await makeMemory('plain', false);
    await seedNode(mem.id, 'data', { greeting: 'hello' });
    const layer = await buildPrismaMemoryLayer(db, 'edge', mem.id, '');
    expect(await layer.read('greeting')).toEqual({ ok: true, value: 'hello' });
  });

  it('walks the source-node parent chain, deepest wins', async () => {
    const mem = await makeMemory('cascade', false);
    await seedNode(mem.id, 'data', { threshold: 1 });
    await seedNode(mem.id, 'conversations', { threshold: 2 });
    await seedNode(mem.id, 'conversations:flow', { threshold: 3 });
    await seedNode(mem.id, 'conversations:flow:check', { threshold: 4 });
    const layer = await buildPrismaMemoryLayer(db, 'edge', mem.id, 'conversations:flow:check');
    expect(await layer.read('threshold')).toEqual({ ok: true, value: 4 });
  });

  it('falls back to a higher ancestor when the deepest node has no value', async () => {
    const mem = await makeMemory('partial', false);
    await seedNode(mem.id, 'data', { greeting: 'root' });
    await seedNode(mem.id, 'conversations', {});
    const layer = await buildPrismaMemoryLayer(db, 'edge', mem.id, 'conversations:flow');
    expect(await layer.read('greeting')).toEqual({ ok: true, value: 'root' });
  });

  it('returns ok: true with undefined value when the path is missing entirely', async () => {
    const mem = await makeMemory('empty', false);
    const layer = await buildPrismaMemoryLayer(db, 'edge', mem.id, '');
    expect(await layer.read('nope')).toEqual({ ok: true, value: undefined });
  });
});

describe('buildPrismaMemoryLayer / encrypted memory (US4)', () => {
  it('returns key_unavailable on every read when no session key is cached', async () => {
    const mem = await makeMemory('locked', true);
    const layer = await buildPrismaMemoryLayer(db, 'user', mem.id, 'conversations:check');
    const result = await layer.read('anything');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('key_unavailable');
      expect(result.error.memoryUrn).toBe(mem.urn);
    }
  });

  it('decrypts data when the active session has the key', async () => {
    const mem = await makeMemory('unlocked', true);

    // Generate a key and cache it for the memory's session.
    const keyB64 = generateDataKey().raw.toString('base64');
    const key = parseDataKey(keyB64);
    sessionKeyCache.set(generateId(), mem.id, key);

    // Write encrypted node data using the same key.
    const enc = encryptNodeFieldsWithKey(
      { content: null, data: { threshold: 7 } },
      key,
    );
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: mem.id,
        loc: 'data',
        name: 'data',
        nodeType: 'info',
        data: (enc.data ?? null) as InputJsonValue,
      },
    });

    const layer = await buildPrismaMemoryLayer(db, 'user', mem.id, '');
    expect(await layer.read('threshold')).toEqual({ ok: true, value: 7 });
  });
});
