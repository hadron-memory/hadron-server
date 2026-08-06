/**
 * Object-store purging on hard delete.
 *
 * The bug this pins: `Asset.memoryId` cascades, so hard-deleting a
 * Memory removed the Asset ROWS while their OBJECTS stayed in the
 * bucket forever — and since the storage key lived only on the deleted
 * row, nothing could ever find them again. Account deletion leaked
 * every file the target's memories held.
 *
 * The ordering is the whole fix, so it is what these tests assert:
 * keys must be collected BEFORE the cascade, or there is nothing left
 * to collect.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { generateDataKey, parseDataKey } from '../crypto.js';
import { encryptStorageKeyForMemory } from './encryption.js';
import {
  collectAssetKeysForMemories,
  purgeCollectedAssetObjects,
} from './purge.js';
import { deleteUserAccount } from '../../controller/operations/deleteUser.js';

const deleteObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../../integrations/r2/client.js', () => ({
  deleteObject: deleteObjectMock,
}));

let org: { id: string; urn: string };
let memory: { id: string };
let encryptedMemory: { id: string };

async function seedAsset(memoryId: string, storageKey: string) {
  const id = generateId();
  await db.asset.create({
    data: {
      id,
      memoryId,
      filename: 'f.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      storageKey,
      scanStatus: 'CLEAN',
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);

  org = await db.organization.create({
    data: { id: generateId(), name: 'purge-org', urn: 'purge-org' },
  });
  memory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:m`,
      name: 'm',
      visibility: 'ORGANIZATION',
    },
  });
  encryptedMemory = await db.memory.create({
    data: {
      class: 'knowledge',
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:enc`,
      name: 'enc',
      visibility: 'ORGANIZATION',
      isEncrypted: true,
    },
  });
});

describe('collectAssetKeysForMemories', () => {
  it('collects plaintext keys for an unencrypted memory', async () => {
    await seedAsset(memory.id, 'org/m/a.pdf');
    await seedAsset(memory.id, 'org/m/b.pdf');

    const collected = await collectAssetKeysForMemories(db, [memory.id]);
    expect(collected.keys.sort()).toEqual(['org/m/a.pdf', 'org/m/b.pdf']);
    expect(collected.undecryptable).toEqual([]);
  });

  it('returns nothing for an empty memory list', async () => {
    await seedAsset(memory.id, 'org/m/a.pdf');
    const collected = await collectAssetKeysForMemories(db, []);
    expect(collected.keys).toEqual([]);
  });

  it('ignores assets in other memories', async () => {
    await seedAsset(memory.id, 'org/m/a.pdf');
    await seedAsset(encryptedMemory.id, 'org/enc/keep.pdf');
    const collected = await collectAssetKeysForMemories(db, [memory.id]);
    expect(collected.keys).toEqual(['org/m/a.pdf']);
  });

  it('decrypts keys for an encrypted memory when the session key is cached', async () => {
    const key = parseDataKey(generateDataKey().raw.toString('base64'));
    sessionKeyCache.set(generateId(), encryptedMemory.id, key);
    const plain = 'org/enc/secret.pdf';
    await seedAsset(
      encryptedMemory.id,
      encryptStorageKeyForMemory(plain, { isEncrypted: true }, key),
    );

    const collected = await collectAssetKeysForMemories(db, [encryptedMemory.id]);
    expect(collected.keys).toEqual([plain]);
    expect(collected.undecryptable).toEqual([]);
  });

  it('reports undecryptable keys instead of silently dropping them', async () => {
    // Encrypted memory with NO cached session key — the known gap. The
    // bytes will be orphaned, and that has to be visible rather than
    // look like a clean purge.
    const ephemeral = parseDataKey(generateDataKey().raw.toString('base64'));
    const assetId = await seedAsset(
      encryptedMemory.id,
      encryptStorageKeyForMemory('org/enc/x.pdf', { isEncrypted: true }, ephemeral),
    );

    const collected = await collectAssetKeysForMemories(db, [encryptedMemory.id]);
    expect(collected.keys).toEqual([]);
    expect(collected.undecryptable).toEqual([assetId]);
  });

  it('collects keys that a subsequent cascade would destroy', async () => {
    // The ordering the fix depends on: collect first, THEN delete. After
    // the cascade the storage key is unrecoverable, so a collection run
    // afterwards returns nothing.
    await seedAsset(memory.id, 'org/m/doomed.pdf');

    const before = await collectAssetKeysForMemories(db, [memory.id]);
    await db.memory.delete({ where: { id: memory.id } });
    const after = await collectAssetKeysForMemories(db, [memory.id]);

    expect(before.keys).toEqual(['org/m/doomed.pdf']);
    expect(after.keys).toEqual([]);
    expect(await db.asset.count()).toBe(0);
  });
});

describe('purgeCollectedAssetObjects', () => {
  it('deletes every collected object', async () => {
    await purgeCollectedAssetObjects(
      { keys: ['a', 'b'], undecryptable: [] },
      'test',
    );
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
    expect(deleteObjectMock).toHaveBeenCalledWith('a');
    expect(deleteObjectMock).toHaveBeenCalledWith('b');
  });

  it('never throws when the object store fails', async () => {
    // A dead object store must not fail the deletion it belongs to —
    // the DB effect is already committed.
    deleteObjectMock.mockRejectedValue(new Error('store down'));
    await expect(
      purgeCollectedAssetObjects({ keys: ['a'], undecryptable: [] }, 'test'),
    ).resolves.toBeUndefined();
  });

  it('continues past a failing key', async () => {
    deleteObjectMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    await purgeCollectedAssetObjects(
      { keys: ['a', 'b'], undecryptable: [] },
      'test',
    );
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });

  it('does not attempt deletes for undecryptable assets', async () => {
    await purgeCollectedAssetObjects(
      { keys: [], undecryptable: ['asset-1'] },
      'test',
    );
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe('deleteUserAccount purges the target’s asset objects', () => {
  it('purges assets in APP-scoped memories, deleted via the App cascade', async () => {
    // Regression: Memory.app is onDelete: Cascade, so `tx.app.deleteMany`
    // takes app-scoped memories and their Asset rows with it. Collecting
    // keys after that point missed them entirely and the bytes were
    // orphaned forever (PR #888 review, Codex P1).
    const user = await db.user.create({
      data: {
        id: generateId(),
        handle: `purge-app-${generateId()}`,
        email: `purge-app-${generateId()}@example.com`,
        roles: ['READER'],
      },
    });
    const app = await db.app.create({
      data: {
        id: generateId(),
        name: 'purge-app',
        urn: `${org.urn}:purge-app`,
        // chk_app_owner_xor: organizationId XOR ownerUserId.
        organizationId: null,
        ownerUserId: user.id,
      } as never,
    });
    const appMemory = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        organizationId: org.id,
        appId: app.id,
        urn: `${org.urn}:purge-app-mem`,
        name: 'app-mem',
        // chk_memory_visibility_class: visibility is NULL unless the
        // class is knowledge/group.
      },
    });
    await seedAsset(appMemory.id, 'org/app-mem/inapp.pdf');

    await deleteUserAccount(db, {
      targetUserId: user.id,
      actorUserId: user.id,
    });
    // The purge is post-commit and fire-and-forget; let it drain.
    await new Promise((r) => setTimeout(r, 50));

    expect(await db.memory.findUnique({ where: { id: appMemory.id } })).toBeNull();
    expect(deleteObjectMock).toHaveBeenCalledWith('org/app-mem/inapp.pdf');
  });

  it('purges assets in the target’s own memories', async () => {
    const user = await db.user.create({
      data: {
        id: generateId(),
        handle: `purge-own-${generateId()}`,
        email: `purge-own-${generateId()}@example.com`,
        roles: ['READER'],
      },
    });
    const owned = await db.memory.create({
      data: {
        class: 'knowledge',
        id: generateId(),
        organizationId: null,
        ownerUserId: user.id,
        urn: `${org.urn}:purge-own-mem`,
        name: 'own-mem',
        visibility: 'ORGANIZATION',
      },
    });
    await seedAsset(owned.id, 'org/own-mem/mine.pdf');

    await deleteUserAccount(db, {
      targetUserId: user.id,
      actorUserId: user.id,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(deleteObjectMock).toHaveBeenCalledWith('org/own-mem/mine.pdf');
  });
});
