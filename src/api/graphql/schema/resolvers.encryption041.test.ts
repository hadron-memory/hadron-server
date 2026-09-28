/**
 * Spec 041 (PR-1) — resolver layer for caller-held-key encryption.
 *
 * Pins: encryptMemory's passphrase path (owner auth, private-class gate,
 * abstract now encrypted, verifier/salt stored), the full unlock loop
 * (passphrase → staged key → plaintext read), and NodeRevision snapshots
 * remaining ciphertext.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { isCiphertext, parseDataKey } from '../../../lib/crypto.js';
import { decryptNodeFields, decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { stageRequestMemoryKeys } from '../../../lib/memoryUnlock.js';
import { requestKeyStorage } from '../../../lib/requestKeys.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

let org: { id: string };
let owner: { id: string };
let stranger: { id: string };
let memoryId: string;
let nodeId: string;

function ownerCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['READER'], userId: owner.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({
    data: { id: generateId(), name: 'enc41-org', urn: 'enc41-org' },
  });
  owner = await db.user.create({
    data: { githubId: 9701, githubUsername: 'enc41-owner', roles: ['READER'] },
  });
  stranger = await db.user.create({
    data: { githubId: 9702, githubUsername: 'enc41-stranger', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'diary',
      urn: 'enc41-org:diary',
      class: 'private',
      userId: owner.id,
    },
  });
  memoryId = memory.id;
  const node = await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: 'entry-1',
      name: 'Entry 1',
      content: 'my secret plaintext',
      abstract: 'A secret abstract.',
      data: { mood: 'good' },
      tags: [],
    },
  });
  nodeId = node.id;
});

afterEach(() => sessionKeyCache.clear());

describe('encryptMemory — passphrase path (spec 041)', () => {
  it('owner encrypts with a passphrase: rows become ciphertext (incl. abstract), verifier+salt stored', async () => {
    const mem = await resolvers.Mutation.encryptMemory(
      {},
      { memoryId, passphrase: 'correct horse battery staple' },
      ownerCtx(),
    );
    expect(mem.isEncrypted).toBe(true);
    const row = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(row.keyVerifier).toMatch(/^enc:v1:/);
    expect(row.kdfSalt).toBeTruthy();
    expect((row.kdfParams as { alg?: string })?.alg).toBe('scrypt');
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isCiphertext(node.content)).toBe(true);
    expect(isCiphertext(node.abstract)).toBe(true); // pre-041 encryptMemory MISSED abstract
    expect((node.data as { __enc?: string })?.__enc).toBeTruthy();
    expect(node.name).toBe('Entry 1'); // plaintext boundary: name stays cleartext
  });

  it('rejects non-private classes and non-owners (typed)', async () => {
    // personal keeps the owner (chk_personal_visibility_user) and pins the
    // exact user-facing boundary: personal does NOT encrypt, private does.
    await db.memory.update({ where: { id: memoryId }, data: { class: 'personal' } });
    await expect(
      resolvers.Mutation.encryptMemory({}, { memoryId, passphrase: 'pw' }, ownerCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await db.memory.update({ where: { id: memoryId }, data: { class: 'private' } });
    await expect(
      resolvers.Mutation.encryptMemory(
        {},
        { memoryId, passphrase: 'pw' },
        { db, roles: ['READER'], userId: stranger.id } as Context,
      ),
      // #1381: the stranger cannot open this private memory, so it answers as a
      // missing one; FORBIDDEN confirmed that it exists.
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND', ref: memoryId });
  });

  it('rejects both-or-neither key inputs', async () => {
    await expect(
      resolvers.Mutation.encryptMemory({}, { memoryId }, ownerCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      resolvers.Mutation.encryptMemory(
        {},
        { memoryId, passphrase: 'pw', dataKey: Buffer.alloc(32).toString('base64') },
        ownerCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('full loop: passphrase unlock via header staging decrypts what encryptMemory wrote', async () => {
    await resolvers.Mutation.encryptMemory({}, { memoryId, passphrase: 'open sesame' }, ownerCtx());
    await requestKeyStorage.run(new Map(), async () => {
      // Wrong passphrase → typed WRONG_KEY at staging time.
      await expect(
        stageRequestMemoryKeys(db, JSON.stringify([{ memory: memoryId, passphrase: 'wrong' }]), owner.id),
      ).rejects.toMatchObject({ code: 'WRONG_KEY' });
      // Right passphrase → staged key decrypts the row, inside this request.
      await stageRequestMemoryKeys(
        db,
        JSON.stringify([{ memory: memoryId, passphrase: 'open sesame' }]),
        owner.id,
      );
      const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
      decryptNodeFields(node, { id: memoryId, isEncrypted: true });
      expect(node.content).toBe('my secret plaintext');
      expect(node.abstract).toBe('A secret abstract.');
      expect(node.data).toEqual({ mood: 'good' });
    });
    // Outside the request scope the memory is locked again.
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });
});

describe('encryptMemory — locked conversion (#1346)', () => {
  const dataKey = Buffer.alloc(32, 7).toString('base64');

  it('preserves a raw edit made after the id scan and reconciles its drift before encrypting', async () => {
    const findMany = db.node.findMany.bind(db.node);
    let injected = false;
    const scan = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (!injected && args?.take === 200 && args.where?.memoryId === memoryId) {
        injected = true;
        // A real committed database write between enumeration and the locked
        // transform. The previous implementation encrypted the older values
        // from `rows` and erased this edit without a visible drift marker.
        await db.node.update({
          where: { id: nodeId },
          data: { content: 'late content', abstract: 'late abstract', data: { mood: 'late' } },
        });
      }
      return rows;
    }) as never);
    try {
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    } finally {
      scan.mockRestore();
    }
    expect(injected).toBe(true);
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const plain = decryptNodeFieldsWithKey(live, parseDataKey(dataKey));
    expect(plain.content).toBe('late content');
    expect(plain.abstract).toBe('late abstract');
    expect(plain.data).toEqual({ mood: 'late' });
    expect(live.revSeq).toBe(2);
    const revisions = await db.nodeRevision.findMany({ where: { nodeId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.editedByInfo).toBe('system:revision-reconcile');
    expect(isCiphertext(revisions[0]!.content)).toBe(true);
    expect(decryptNodeFieldsWithKey(revisions[0]!, parseDataKey(dataKey)).content).toBe('late content');
  });

  it('keeps a clean conversion at revision 1 without a fabricated reconcile', async () => {
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(decryptNodeFieldsWithKey(live, parseDataKey(dataKey)).content).toBe('my secret plaintext');
    expect(live.revSeq).toBe(1);
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
  });

  it('does not encrypt or reconcile a row moved to another memory after enumeration', async () => {
    const destination = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:other-diary',
        name: 'other diary', class: 'private', userId: owner.id,
      },
    });
    const findMany = db.node.findMany.bind(db.node);
    let moved = false;
    const scan = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (!moved && args?.take === 200 && args.where?.memoryId === memoryId) {
        moved = true;
        await db.node.update({ where: { id: nodeId }, data: { memoryId: destination.id } });
      }
      return rows;
    }) as never);
    try {
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    } finally {
      scan.mockRestore();
    }
    expect(moved).toBe(true);
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(node.memoryId).toBe(destination.id);
    expect(node.content).toBe('my secret plaintext');
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
  });

  it('allows only one of two callers that both saw plaintext to claim the encryption key', async () => {
    const otherKey = Buffer.alloc(32, 8).toString('base64');
    const findMemory = db.memory.findUniqueOrThrow.bind(db.memory);
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
    let plaintextReads = 0;
    const read = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
      const memory = await findMemory(args);
      if (memory.id === memoryId && !memory.isEncrypted && plaintextReads < 2) {
        plaintextReads++;
        if (plaintextReads === 2) releaseReads();
        await bothRead;
      }
      return memory;
    }) as never);
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([
        resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx()),
        resolvers.Mutation.encryptMemory({}, { memoryId, dataKey: otherKey }, ownerCtx()),
      ]);
    } finally {
      read.mockRestore();
    }
    expect(plaintextReads).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winnerKey = results[0].status === 'fulfilled' ? dataKey : otherKey;
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(decryptNodeFieldsWithKey(node, parseDataKey(winnerKey)).content).toBe('my secret plaintext');
  });
});
