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
import { decryptNodeFields, decryptNodeFieldsWithKey, encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { stageRequestMemoryKeys } from '../../../lib/memoryUnlock.js';
import { requestKeyStorage } from '../../../lib/requestKeys.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';

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

  it('refuses the former owner when a transfer wins the memory row lock', async () => {
    const destination = await db.organization.create({
      data: { id: generateId(), name: 'Encryption receiver', urn: 'encryption-receiver' },
    });
    let pending: ReturnType<typeof resolvers.Mutation.encryptMemory> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE`;
      pending = resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
      await waitForLockWaiters(db);
      await tx.memory.update({ where: { id: memoryId }, data: {
        organizationId: destination.id, userId: null, class: 'knowledge',
      } });
    }, { timeout: 10_000 });
    await expect(pending!).rejects.toThrow();
    expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toMatchObject({
      organizationId: destination.id, class: 'knowledge', isEncrypted: false, keyVerifier: null,
    });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content)
      .toBe('my secret plaintext');
  });

  it('converts old plaintext history in a memory encrypted before this fix', async () => {
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const before = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const old = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'old stored secret', abstract: 'old stored abstract',
        data: { secret: 'old stored data' }, nodeType: 'info',
      },
    });
    expect(await resolvers.Query.nodeRevision({}, { revisionId: old.id }, ownerCtx()))
      .toMatchObject({ content: null, abstract: null, data: null });
    const wrongKey = Buffer.alloc(32, 8).toString('base64');
    await expect(resolvers.Mutation.encryptMemory(
      {}, { memoryId, dataKey: wrongKey }, ownerCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'WRONG_KEY', memoryId } });
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: old.id } })).content)
      .toBe('old stored secret');

    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const stored = await db.nodeRevision.findUniqueOrThrow({ where: { id: old.id } });
    expect(isCiphertext(stored.content)).toBe(true);
    expect(isCiphertext(stored.abstract)).toBe(true);
    expect((stored.data as { __enc?: string })?.__enc).toBeTruthy();
    expect(decryptNodeFieldsWithKey({ ...stored }, parseDataKey(dataKey))).toMatchObject({
      content: 'old stored secret', abstract: 'old stored abstract',
      data: { secret: 'old stored data' },
    });
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const repeated = await db.nodeRevision.findUniqueOrThrow({ where: { id: old.id } });
    expect([repeated.content, repeated.abstract, repeated.data])
      .toEqual([stored.content, stored.abstract, stored.data]);
    const after = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect([after.isEncrypted, after.keyVerifier, after.kdfSalt, after.kdfParams])
      .toEqual([before.isEncrypted, before.keyVerifier, before.kdfSalt, before.kdfParams]);
  });

  it('finds a revision committed after the first history scan reaches its end', async () => {
    const findMany = db.nodeRevision.findMany.bind(db.nodeRevision);
    let lateRevisionId: string | undefined;
    const scan = vi.spyOn(db.nodeRevision, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (!lateRevisionId && args?.take === 200 && args.where?.OR && rows.length === 0) {
        lateRevisionId = generateId();
        await db.nodeRevision.create({
          data: {
            id: lateRevisionId, nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
            content: 'late plaintext revision',
          },
        });
      }
      return rows;
    }) as typeof db.nodeRevision.findMany);
    try {
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    } finally {
      scan.mockRestore();
    }
    expect(lateRevisionId).toBeTruthy();
    expect(isCiphertext((await db.nodeRevision.findUniqueOrThrow({ where: { id: lateRevisionId! } })).content))
      .toBe(true);
  });

  it('refuses a node writer that read plaintext state before the encryption flip', async () => {
    const findMemory = db.memory.findUniqueOrThrow.bind(db.memory);
    let reached!: () => void;
    let release!: () => void;
    const atOldFlag = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const lookup = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
      const row = await findMemory(args);
      if (!held && args?.where?.id === memoryId && args.select?.isEncrypted === true) {
        held = true;
        reached();
        await resume;
      }
      return row;
    }) as unknown as typeof db.memory.findUniqueOrThrow);
    try {
      const writer = resolvers.Mutation.updateNode(
        {}, { input: { id: nodeId, content: 'late plaintext update' } } as never, ownerCtx(),
      );
      await atOldFlag;
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
      release();
      await expect(writer).rejects.toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    } finally {
      release();
      lookup.mockRestore();
    }
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isCiphertext(live.content)).toBe(true);
    expect((await db.nodeRevision.findMany({ where: { nodeId } }))
      .every((revision) => revision.content == null || isCiphertext(revision.content))).toBe(true);
  });

  it('derives the stored passphrase key but refuses verifier-less legacy completion', async () => {
    const passphrase = 'existing encryption passphrase';
    await resolvers.Mutation.encryptMemory({}, { memoryId, passphrase }, ownerCtx());
    const prior = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'old passphrase secret',
      },
    });
    await resolvers.Mutation.encryptMemory({}, { memoryId, passphrase }, ownerCtx());
    expect(isCiphertext((await db.nodeRevision.findUniqueOrThrow({ where: { id: prior.id } })).content))
      .toBe(true);

    const noVerifier = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'unverifiable secret',
      },
    });
    await db.memory.update({ where: { id: memoryId }, data: { keyVerifier: null } });
    await expect(resolvers.Mutation.encryptMemory(
      {}, { memoryId, passphrase: 'wrong passphrase' }, ownerCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT', memoryId } });
    await expect(resolvers.Mutation.encryptMemory(
      {}, { memoryId, passphrase }, ownerCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT', memoryId } });
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: noVerifier.id } })).content)
      .toBe('unverifiable secret');
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).keyVerifier).toBeNull();
  });

  it('converts pre-existing revision history without changing another memory\'s snapshots', async () => {
    const other = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:other-history',
        name: 'other history', class: 'private', userId: stranger.id,
      },
    });
    const historical = await Promise.all([
      db.nodeRevision.create({
        data: {
          id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
          content: 'prior content', abstract: 'prior abstract', data: { secret: 'prior' },
        },
      }),
      db.nodeRevision.create({
        data: {
          id: generateId(), nodeId, memoryId: null, loc: 'entry-1', name: 'Entry 1',
          content: 'legacy content', abstract: 'legacy abstract', data: { secret: 'legacy' },
        },
      }),
      db.nodeRevision.create({
        data: {
          id: generateId(), nodeId, memoryId: other.id, loc: 'entry-1', name: 'Entry 1',
          content: 'foreign content', abstract: 'foreign abstract', data: { secret: 'foreign' },
        },
      }),
    ]);

    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());

    for (const [revision, content, abstract, data] of [
      [historical[0]!, 'prior content', 'prior abstract', { secret: 'prior' }],
      [historical[1]!, 'legacy content', 'legacy abstract', { secret: 'legacy' }],
    ] as const) {
      const stored = await db.nodeRevision.findUniqueOrThrow({ where: { id: revision.id } });
      expect(isCiphertext(stored.content)).toBe(true);
      expect(isCiphertext(stored.abstract)).toBe(true);
      expect((stored.data as { __enc?: string })?.__enc).toBeTruthy();
      const decrypted = decryptNodeFieldsWithKey(stored, parseDataKey(dataKey));
      expect([decrypted.content, decrypted.abstract, decrypted.data]).toEqual([content, abstract, data]);
    }
    const foreign = await db.nodeRevision.findUniqueOrThrow({ where: { id: historical[2]!.id } });
    expect([foreign.content, foreign.abstract, foreign.data]).toEqual([
      'foreign content', 'foreign abstract', { secret: 'foreign' },
    ]);
    const readable = await resolvers.Query.nodeRevisions({}, { nodeRef: nodeId }, ownerCtx());
    expect(readable.map((revision) => revision.id).sort()).toEqual(
      historical.slice(0, 2).map((revision) => revision.id).sort(),
    );
    expect(readable.every((revision) => revision.content === null && revision.abstract === null && revision.data === null)).toBe(true);
    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      const unlocked = await resolvers.Query.nodeRevisions({}, { nodeRef: nodeId }, ownerCtx());
      expect(unlocked.find((revision) => revision.id === historical[0]!.id)).toMatchObject({
        content: 'prior content', abstract: 'prior abstract', data: { secret: 'prior' },
      });
      expect(await resolvers.Query.nodeRevision({}, { revisionId: historical[0]!.id }, ownerCtx()))
        .toMatchObject({ content: 'prior content', abstract: 'prior abstract' });
      expect(await resolvers.Mutation.updateNodeRevision(
        {}, { revisionId: historical[0]!.id, revLabel: 'readable' }, ownerCtx(),
      )).toMatchObject({ content: 'prior content', abstract: 'prior abstract' });
    });
    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      await resolvers.Mutation.restoreNodeRevision(
        {}, { revisionId: historical[0]!.id }, ownerCtx(),
      );
    });
    const restored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isCiphertext(restored.content)).toBe(true);
    expect(decryptNodeFieldsWithKey(restored, parseDataKey(dataKey)).content).toBe('prior content');
  });

  it('encrypts marker-shaped old plaintext and conceals it from locked revision reads', async () => {
    const content = 'enc:v1:ordinary text, not an envelope';
    const abstract = 'enc:v1:ordinary abstract';
    const data = { __enc: 'ordinary data', detail: 'still plaintext' };
    await db.node.update({ where: { id: nodeId }, data: { content, abstract, data } });
    const prior = await db.nodeRevision.create({
      data: { id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1', content, abstract, data },
    });
    const dataKey = Buffer.alloc(32, 37).toString('base64');
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());

    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const stored = await db.nodeRevision.findUniqueOrThrow({ where: { id: prior.id } });
    const key = parseDataKey(dataKey);
    expect(decryptNodeFieldsWithKey({ ...live }, key)).toMatchObject({ content, abstract, data });
    expect(decryptNodeFieldsWithKey({ ...stored }, key)).toMatchObject({ content, abstract, data });
    const locked = await resolvers.Query.nodeRevision({}, { revisionId: prior.id }, ownerCtx());
    expect(locked).toMatchObject({ content: null, abstract: null, data: null });
    await requestKeyStorage.run(new Map([[memoryId, key]]), async () => {
      const unlocked = await resolvers.Query.nodeRevision({}, { revisionId: prior.id }, ownerCtx());
      expect(unlocked).toMatchObject({ content, abstract, data });
    });
  });

  it('fails a verifier-less historical read when the supplied key is wrong', async () => {
    const key = parseDataKey(Buffer.alloc(32, 37).toString('base64'));
    const wrongKey = parseDataKey(Buffer.alloc(32, 38).toString('base64'));
    const stored = encryptNodeFieldsWithKey({
      content: 'history secret', abstract: 'history abstract', data: { secret: true },
    }, key);
    await db.memory.update({
      where: { id: memoryId }, data: { isEncrypted: true, keyVerifier: null, vectorIndexEnabled: false },
    });
    const revision = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: stored.content, abstract: stored.abstract, data: stored.data as never,
      },
    });
    await requestKeyStorage.run(new Map([[memoryId, wrongKey]]), async () => {
      await expect(resolvers.Query.nodeRevision({}, { revisionId: revision.id }, ownerCtx()))
        .rejects.toThrow();
    });
    await requestKeyStorage.run(new Map([[memoryId, key]]), async () => {
      expect(await resolvers.Query.nodeRevision({}, { revisionId: revision.id }, ownerCtx()))
        .toMatchObject({ content: 'history secret', abstract: 'history abstract', data: { secret: true } });
    });
  });

  it('pages more than 200 old snapshots and encrypts tombstone history', async () => {
    // encryptMemory pages 200 snapshots. Keep exactly one beyond that boundary
    // (#1999), with tombstone history on the second page. The fixture is already
    // at the boundary minimum, yet it still took 5.1 s alone at host load ~94
    // (#2003), so the case carries an explicit 20 s limit (about 4x the worst
    // observed time; a candidate margin, waits not instrumented). A hang still fails.
    const snapshotCount = 201;
    const deleted = await db.node.create({
      data: {
        id: generateId(), memoryId, loc: 'deleted-history', name: 'deleted history',
        content: 'deleted live', deletedAt: new Date(),
      },
    });
    // UUIDv7's random suffix does not order IDs generated in the same millisecond.
    const snapshotIds = Array.from({ length: snapshotCount }, () => generateId()).sort();
    const history = snapshotIds.map((id, index) => ({
      id, nodeId: index === snapshotCount - 1 ? deleted.id : nodeId,
      memoryId, loc: index === snapshotCount - 1 ? 'deleted-history' : 'entry-1',
      name: 'history', content: `historical ${index}`,
    }));
    await db.nodeRevision.createMany({ data: history });

    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());

    const rows = await db.nodeRevision.findMany({ where: { id: { in: history.map((r) => r.id) } } });
    expect(rows).toHaveLength(snapshotCount);
    expect(rows.every((revision) => isCiphertext(revision.content))).toBe(true);
    const tombstoneHistory = rows.find((revision) => revision.nodeId === deleted.id)!;
    expect(decryptNodeFieldsWithKey(tombstoneHistory, parseDataKey(dataKey)).content).toBe(`historical ${snapshotCount - 1}`);
  }, 20_000);

  // #2003: same 201-row fixture and `encryptMemory` as the case above, which
  // timed out at vitest's 5 s default on the shared agent host in one
  // reporter's full runs (reported, not reproduced here: 1.1 s quiet, 3.6 s
  // once at host load ~90). 20 s is a candidate margin, waits were not
  // instrumented; a hang still fails, later.
  it('continues past a pruned page-boundary snapshot', async () => {
    const history = Array.from({ length: 201 }, (_, index) => ({
      id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'history',
      content: `snapshot ${index}`,
    }));
    await db.nodeRevision.createMany({ data: history });
    const findMany = db.nodeRevision.findMany.bind(db.nodeRevision);
    let pruned = false;
    let pages = 0;
    const scan = vi.spyOn(db.nodeRevision, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (args?.take === 200) {
        pages++;
        if (!pruned && rows.length === 200) {
          pruned = true;
          await db.nodeRevision.delete({ where: { id: rows[199]!.id } });
        }
      }
      return rows;
    }) as never);
    try {
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    } finally {
      scan.mockRestore();
    }
    expect(pruned).toBe(true);
    expect(pages).toBeGreaterThanOrEqual(2);
    const remaining = await db.nodeRevision.findMany({ where: { nodeId } });
    expect(remaining).toHaveLength(200);
    expect(remaining.every((revision) => isCiphertext(revision.content))).toBe(true);
  }, 20_000);

  it('rechecks legacy ownership when a node moves after the revision page read', async () => {
    const destination = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:moved-history',
        name: 'moved history', class: 'private', userId: owner.id,
      },
    });
    const legacy = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId: null, loc: 'entry-1', name: 'legacy',
        content: 'destination history',
      },
    });
    const source = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'source',
        content: 'source history',
      },
    });
    const findMany = db.nodeRevision.findMany.bind(db.nodeRevision);
    let moved = false;
    const scan = vi.spyOn(db.nodeRevision, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (!moved && args?.take === 200) {
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
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: legacy.id } })).content)
      .toBe('destination history');
    expect(isCiphertext((await db.nodeRevision.findUniqueOrThrow({ where: { id: source.id } })).content))
      .toBe(true);
  });

  it('restores a source-encrypted snapshot into a plaintext destination as plaintext', async () => {
    const destination = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:restore-destination',
        name: 'restore destination', class: 'private', userId: owner.id,
      },
    });
    const prior = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'source historical secret', abstract: 'source historical abstract',
        data: { secret: 'source history' }, nodeType: 'info',
      },
    });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: destination.id } });
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    const encryptedHistory = await db.nodeRevision.findUniqueOrThrow({ where: { id: prior.id } });
    expect(isCiphertext(encryptedHistory.content)).toBe(true);

    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      expect(await resolvers.Query.nodeRevision({}, { revisionId: prior.id }, ownerCtx()))
        .toMatchObject({ content: 'source historical secret' });
      await resolvers.Mutation.restoreNodeRevision({}, { revisionId: prior.id }, ownerCtx());
    });
    const restored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect([restored.content, restored.abstract, restored.data]).toEqual([
      'source historical secret', 'source historical abstract', { secret: 'source history' },
    ]);
  });

  it('restores a source-encrypted snapshot under the encrypted destination key', async () => {
    const destinationKey = Buffer.alloc(32, 9).toString('base64');
    const destination = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:encrypted-restore-destination',
        name: 'encrypted restore destination', class: 'private', userId: owner.id,
      },
    });
    const prior = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'source snapshot secret', abstract: 'source snapshot abstract',
        data: { secret: 'source snapshot data' }, nodeType: 'info',
      },
    });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: destination.id } });
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    await resolvers.Mutation.encryptMemory({}, { memoryId: destination.id, dataKey: destinationKey }, ownerCtx());

    await expect(resolvers.Mutation.restoreNodeRevision(
      {}, { revisionId: prior.id }, ownerCtx(),
    )).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED', memoryId } });
    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      await expect(resolvers.Mutation.restoreNodeRevision(
        {}, { revisionId: prior.id }, ownerCtx(),
      )).rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED', memoryId: destination.id } });
    });
    await requestKeyStorage.run(new Map([
      [memoryId, parseDataKey(dataKey)],
      [destination.id, parseDataKey(destinationKey)],
    ]), async () => {
      const response = await resolvers.Mutation.restoreNodeRevision({}, { revisionId: prior.id }, ownerCtx());
      expect(response).toMatchObject({
        content: 'source snapshot secret', abstract: 'source snapshot abstract',
        data: { secret: 'source snapshot data' },
      });
    });
    const restored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isCiphertext(restored.content)).toBe(true);
    expect(isCiphertext(restored.abstract)).toBe(true);
    expect((restored.data as { __enc?: string })?.__enc).toBeTruthy();
    expect(decryptNodeFieldsWithKey(restored, parseDataKey(destinationKey))).toMatchObject({
      content: 'source snapshot secret', abstract: 'source snapshot abstract',
      data: { secret: 'source snapshot data' },
    });
  });

  it('does not record a content change when restore only rotates ciphertext', async () => {
    const prior = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'my secret plaintext', abstract: 'A secret abstract.',
        data: { mood: 'good' }, nodeType: 'info',
      },
    });
    await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      await resolvers.Mutation.restoreNodeRevision({}, { revisionId: prior.id }, ownerCtx());
    });
    const beforeRestore = await db.nodeRevision.findFirstOrThrow({
      where: { nodeId, id: { not: prior.id } }, orderBy: { createdAt: 'desc' },
    });
    expect(beforeRestore.changes).not.toContain('content');
    expect(beforeRestore.changes).not.toContain('abstract');
    expect(beforeRestore.changes).not.toContain('data');
  });

  it('does not restore a prior-memory snapshot for a caller who cannot read that memory', async () => {
    const destination = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: 'enc41-org:foreign-restore',
        name: 'foreign restore', class: 'private', userId: stranger.id,
      },
    });
    const prior = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
        content: 'prior owner secret',
      },
    });
    await db.node.update({ where: { id: nodeId }, data: { memoryId: destination.id } });

    await expect(resolvers.Mutation.restoreNodeRevision(
      {}, { revisionId: prior.id },
      { db, roles: ['READER'], userId: stranger.id } as Context,
    )).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content)
      .toBe('my secret plaintext');
  });

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

  it('encrypts tombstones without leaking a raw-edit reconcile revision', async () => {
    const cleanDeleted = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'clean-delete', name: 'clean-delete', content: 'clean' },
    });
    const alreadyDeleted = await db.node.create({
      data: {
        id: generateId(), memoryId, loc: 'prior-delete', name: 'prior-delete',
        content: 'prior tombstone', deletedAt: new Date(),
      },
    });
    const findMany = db.node.findMany.bind(db.node);
    let injected = false;
    const scan = vi.spyOn(db.node, 'findMany').mockImplementation((async (args: Parameters<typeof findMany>[0]) => {
      const rows = await findMany(args);
      if (!injected && args?.take === 200 && args.where?.memoryId === memoryId) {
        injected = true;
        const deletedAt = new Date();
        // This combines an unrevisioned raw content edit with a soft delete.
        // The conversion must encrypt both this row and any NEW reconcile
        // snapshot, even though a soft delete arrived after enumeration.
        await db.node.update({
          where: { id: nodeId },
          data: {
            content: 'deleted canary', abstract: 'deleted abstract',
            data: { secret: 'deleted data' }, deletedAt,
          },
        });
        await db.node.update({ where: { id: cleanDeleted.id }, data: { deletedAt } });
      }
      return rows;
    }) as never);
    try {
      await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
    } finally {
      scan.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(true);
    for (const [id, expected] of [
      [nodeId, 'deleted canary'], [cleanDeleted.id, 'clean'], [alreadyDeleted.id, 'prior tombstone'],
    ]) {
      const row = await db.node.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).not.toBeNull();
      expect(isCiphertext(row.content)).toBe(true);
      expect(decryptNodeFieldsWithKey(row, parseDataKey(dataKey)).content).toBe(expected);
    }
    const revisions = await db.nodeRevision.findMany({ where: { nodeId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.editedByInfo).toBe('system:revision-reconcile');
    expect(isCiphertext(revisions[0]!.content)).toBe(true);
    expect(decryptNodeFieldsWithKey(revisions[0]!, parseDataKey(dataKey)).content).toBe('deleted canary');
    expect(await db.nodeRevision.count({ where: { nodeId: { in: [cleanDeleted.id, alreadyDeleted.id] } } })).toBe(0);
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
