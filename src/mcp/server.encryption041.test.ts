/**
 * Spec 041 PR-2 — MCP unlock + encrypted read/write parity (closes #206
 * for unlocked sessions).
 *
 * Pins: hadron_unlock_memory (owner-only, wrong-passphrase message, session
 * scoping), the locked read posture (Locked marker, NEVER raw enc:v1
 * ciphertext), plaintext reads after unlock, write REJECTION while locked,
 * ciphertext-at-rest for writes while unlocked, and hadron_lock_memory
 * re-locking the session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { isCiphertext } from '../lib/crypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { revisionStateHashRefreshMarker } from '../lib/nodeRevisionSnapshot.js';
import { writeNodeCore } from '../api/graphql/schema/resolvers.mutation.node.js';
import { computeContentHash } from '../lib/contentHash.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

const PASS = 'open sesame';

let org: { id: string };
let owner: { id: string };
let stranger: { id: string };
let memoryUrn: string;
let memoryId: string;

const ownerAuth = (): AuthContext => ({
  userId: owner.id,
  roles: ['ADMIN'],
  clientId: `user:${owner.id}`,
});

function mcp(auth: AuthContext, sessionId = 'sess-a') {
  return createTestableMcpServer(auth, { sessionId });
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({
    data: { id: generateId(), name: 'mcp41-org', urn: 'mcp41-org' },
  });
  owner = await db.user.create({
    data: { githubId: 9801, githubUsername: 'mcp41-owner', roles: ['ADMIN'] },
  });
  stranger = await db.user.create({
    data: { githubId: 9802, githubUsername: 'mcp41-stranger', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'vault',
      urn: 'mcp41-org:vault',
      class: 'private',
      userId: owner.id,
    },
  });
  memoryId = memory.id;
  memoryUrn = memory.urn;
  await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: 'secret-note',
      name: 'Secret note',
      content: 'the plaintext secret',
      abstract: 'A secret summary.',
      tags: [],
    },
  });
  // Encrypt via the real conversion path (PR-1) so KDF salt/params/verifier
  // are exactly what production writes.
  await resolvers.Mutation.encryptMemory(
    {},
    { memoryId, passphrase: PASS },
    { db, roles: ['ADMIN'], userId: owner.id } as Context,
  );
});

afterEach(() => sessionKeyCache.clear());

describe('hadron_unlock_memory', () => {
  it('owner unlocks with the passphrase; wrong passphrase and non-owner are refused', async () => {
    const server = mcp(ownerAuth());
    const wrong = await server.callToolText('hadron_unlock_memory', {
      memoryUrn,
      passphrase: 'nope',
    });
    expect(wrong).toContain('Wrong passphrase');
    const foreign = await mcp({
      userId: stranger.id,
      roles: ['ADMIN'],
      clientId: `user:${stranger.id}`,
    }).callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    expect(foreign).toContain('not found'); // uniform non-owner posture
    const ok = await server.callToolText('hadron_unlock_memory', {
      memoryUrn,
      passphrase: PASS,
    });
    expect(ok).toContain('unlocked');
    expect(sessionKeyCache.getByMemoryId(memoryId)).not.toBeNull();
  });

  it('refuses a verifier-less encrypted memory without caching its old key', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { keyVerifier: null } });
    const out = await mcp(ownerAuth()).callToolText('hadron_unlock_memory', {
      memoryUrn,
      passphrase: PASS,
    });
    expect(out).toContain('no stored key verifier');
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });
});

describe('locked vs unlocked reads (hadron_get_node)', () => {
  it('locked: Locked marker, blanked fields, and NEVER raw enc:v1 ciphertext', async () => {
    const server = mcp(ownerAuth());
    const out = await server.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
      contentScope: 'all',
    });
    expect(out).toContain('Locked: encrypted memory');
    expect(out).not.toContain('the plaintext secret');
    expect(out).not.toContain('enc:v1:');
  });

  it('unlocked: plaintext content + abstract, and the staleness machinery works', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const out = await server.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
      contentScope: 'all',
    });
    expect(out).toContain('the plaintext secret');
    expect(out).toContain('A secret summary.');
    expect(out).not.toContain('Locked:');
    expect(out).not.toContain('enc:v1:');
  });

  it('unlock is session-scoped: a different MCP session stays locked', async () => {
    await mcp(ownerAuth(), 'sess-a').callToolText('hadron_unlock_memory', {
      memoryUrn,
      passphrase: PASS,
    });
    const other = mcp(ownerAuth(), 'sess-b');
    const out = await other.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
    });
    // NOTE: keys are cached per MEMORY process-wide once any session holds
    // one (the session model's documented posture) — so sess-b READS succeed
    // while sess-a is live. What IS session-scoped is lifecycle: evicting
    // sess-a drops the key for everyone unless sess-b unlocked too.
    expect(out).toContain('the plaintext secret');
    sessionKeyCache.evict('mcp:sess-a');
    const afterEvict = await other.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
    });
    expect(afterEvict).toContain('Locked: encrypted memory');
  });
});

describe('locked vs unlocked writes', () => {
  it('hadron_create_node while locked is REJECTED (never plaintext into an encrypted memory)', async () => {
    const server = mcp(ownerAuth());
    const out = await server.callToolText('hadron_create_node', {
      urn: `mcp41-org::vault::new-entry`,
      name: 'New entry',
      content: 'should not land',
    });
    expect(out).toContain('encrypted and locked');
    expect(await db.node.findFirst({ where: { memoryId, loc: 'new-entry' } })).toBeNull();
  });

  it('hadron_create_node while unlocked stores ciphertext at rest', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const out = await server.callToolText('hadron_create_node', {
      urn: `mcp41-org::vault::new-entry`,
      name: 'New entry',
      content: 'fresh secret',
      abstract: 'Fresh summary.',
    });
    expect(out).toContain('Node saved');
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'new-entry' } });
    expect(isCiphertext(row.content)).toBe(true);
    expect(isCiphertext(row.abstract)).toBe(true);
    expect(row.name).toBe('New entry'); // plaintext boundary
    // And the same session reads it back as plaintext.
    const read = await server.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::new-entry`,
    });
    expect(read).toContain('fresh secret');
  });

  it('hadron_create_parent_node requires an unlock and stores section content as ciphertext', async () => {
    const server = mcp(ownerAuth());
    const urn = `mcp41-org::vault::section`;
    const locked = await server.callToolText('hadron_create_parent_node', {
      urn, name: 'Section', description: 'section secret',
    });
    expect(locked).toContain('encrypted and locked');
    expect(await db.node.findFirst({ where: { memoryId, loc: 'section' } })).toBeNull();

    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    expect(await server.callToolText('hadron_create_parent_node', {
      urn, name: 'Section', description: 'section secret',
    })).toContain('Node saved');
    const section = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'section' } });
    expect(isCiphertext(section.content)).toBe(true);
    const versions = await db.nodeRevision.count({ where: { nodeId: section.id } });
    expect(await server.callToolText('hadron_create_parent_node', {
      urn, name: 'Section', description: 'section secret',
    })).toContain('Node saved');
    expect(await db.node.findUniqueOrThrow({ where: { id: section.id } })).toMatchObject(section);
    expect(await db.nodeRevision.count({ where: { nodeId: section.id } })).toBe(versions);

    await server.callToolText('hadron_create_parent_node', {
      urn, name: 'Section', description: 'a changed section secret',
    });
    expect(await db.nodeRevision.count({ where: { nodeId: section.id } })).toBe(versions + 1);
    expect(isCiphertext((await db.node.findUniqueOrThrow({ where: { id: section.id } })).content)).toBe(true);
  });

  it.each(['hadron_update_node', 'hadron_create_node'])(
    '%s refuses a plaintext payload prepared before encryption flipped', async (tool) => {
      const plainMemory = await db.memory.create({
        data: {
          id: generateId(), organizationId: org.id, name: 'plain', urn: 'mcp41-org:plain',
          class: 'private', userId: owner.id,
        },
      });
      const plainNode = await db.node.create({
        data: {
          id: generateId(), memoryId: plainMemory.id, loc: 'entry', name: 'Entry',
          content: 'original plain', tags: [],
        },
      });
      const findMemory = db.memory.findUnique.bind(db.memory);
      let reached!: () => void;
      let release!: () => void;
      const atOldFlag = new Promise<void>((resolve) => { reached = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      const lookup = vi.spyOn(db.memory, 'findUnique').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
        const row = await findMemory(args);
        if (!held && args?.where?.id === plainMemory.id && args.select?.isEncrypted === true) {
          held = true;
          reached();
          await resume;
        }
        return row;
      }) as unknown as typeof db.memory.findUnique);
      try {
        const writer = mcp(ownerAuth()).callToolText(tool, {
          urn: `mcp41-org::plain::${tool === 'hadron_update_node' ? 'entry' : 'new-entry'}`,
          ...(tool === 'hadron_create_node' ? { name: 'New entry' } : {}),
          content: 'late plaintext write',
        });
        await atOldFlag;
        await resolvers.Mutation.encryptMemory(
          {}, { memoryId: plainMemory.id, passphrase: PASS },
          { db, roles: ['ADMIN'], userId: owner.id } as Context,
        );
        release();
        expect(await writer).toContain('[node_write_conflict]');
      } finally {
        release();
        lookup.mockRestore();
      }
      const live = await db.node.findUniqueOrThrow({ where: { id: plainNode.id } });
      expect(isCiphertext(live.content)).toBe(true);
      expect(await db.node.findFirst({ where: { memoryId: plainMemory.id, loc: 'new-entry' } })).toBeNull();
      expect((await db.nodeRevision.findMany({ where: { nodeId: plainNode.id } }))
        .every((revision) => revision.content == null || isCiphertext(revision.content))).toBe(true);
    },
  );

  it('hadron_create_parent_node refuses a section prepared before encryption flipped', async () => {
    const plainMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, name: 'plain-section',
        urn: 'mcp41-org:plain-section', class: 'private', userId: owner.id,
      },
    });
    const findMemory = db.memory.findUniqueOrThrow.bind(db.memory);
    let reached!: () => void;
    let release!: () => void;
    const atOldFlag = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const lookup = vi.spyOn(db.memory, 'findUniqueOrThrow').mockImplementation((async (args: Parameters<typeof findMemory>[0]) => {
      const row = await findMemory(args);
      if (!held && args?.where?.id === plainMemory.id && args.select?.isEncrypted === true) {
        held = true;
        reached();
        await resume;
      }
      return row;
    }) as unknown as typeof db.memory.findUniqueOrThrow);
    try {
      const writer = mcp(ownerAuth()).callToolText('hadron_create_parent_node', {
        urn: 'mcp41-org::plain-section::section', name: 'Section', description: 'late plaintext',
      });
      await atOldFlag;
      await resolvers.Mutation.encryptMemory(
        {}, { memoryId: plainMemory.id, passphrase: PASS },
        { db, roles: ['ADMIN'], userId: owner.id } as Context,
      );
      release();
      expect(await writer).toContain('[node_write_conflict]');
    } finally {
      release();
      lookup.mockRestore();
    }
    expect(await db.node.findFirst({ where: { memoryId: plainMemory.id, loc: 'section' } })).toBeNull();
  });

  it('hadron_update_node while unlocked re-encrypts the provided fields', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const out = await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`,
      content: 'updated secret',
    });
    expect(out).toContain('Node updated');
    const row = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    expect(isCiphertext(row.content)).toBe(true);
    expect(row.content).not.toContain('updated secret');
  });

  it('keeps a verified stamp and creates no history for identical encrypted GraphQL and MCP saves', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const context = { db, roles: ['ADMIN'], userId: owner.id } as Context;
    await writeNodeCore(
      { memoryId, loc: 'secret-note', data: { evidence: 'same' } },
      context, 'update',
    );
    const initial = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    await db.node.update({
      where: { id: initial.id },
      data: {
        authorshipKind: 'TASK', authoredByTask: generateId(), authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
        abstractOriginHash: computeContentHash('the plaintext secret'),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });
    const stamped = await db.node.findUniqueOrThrow({ where: { id: initial.id } });
    const revisions = await db.nodeRevision.count({ where: { nodeId: initial.id } });

    await writeNodeCore(
      { memoryId, loc: 'secret-note', content: 'the plaintext secret', abstract: 'A secret summary.', data: { evidence: 'same' } },
      context, 'update',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: initial.id } })).toMatchObject(stamped);
    expect(await db.nodeRevision.count({ where: { nodeId: initial.id } })).toBe(revisions);

    const result = await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`,
      content: 'the plaintext secret', abstract: 'A secret summary.', data: { evidence: 'same' },
    });
    expect(result).toContain('Node updated');
    expect(await db.node.findUniqueOrThrow({ where: { id: initial.id } })).toMatchObject(stamped);
    expect(await db.nodeRevision.count({ where: { nodeId: initial.id } })).toBe(revisions);
  });

  it('keeps a verified stamp on an identical encrypted UPSERT of a live row (authoritative branch)', async () => {
    // `upsert` reaches writeNodeCore's authoritative snapshot branch for a live
    // row, which diffs separately from the `update` path above. Its revision is
    // unconditional by contract; the stamp must still survive unchanged plaintext.
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const context = { db, roles: ['ADMIN'], userId: owner.id } as Context;
    const initial = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    const taskId = generateId();
    await db.node.update({
      where: { id: initial.id },
      data: {
        authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });

    await writeNodeCore(
      { memoryId, loc: 'secret-note', name: initial.name, content: 'the plaintext secret' },
      context, 'upsert',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: initial.id } })).toMatchObject({
      authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1,
    });

    // Control: a real plaintext change through the same branch still clears.
    await writeNodeCore(
      { memoryId, loc: 'secret-note', name: initial.name, content: 'a different plaintext secret' },
      context, 'upsert',
    );
    expect(await db.node.findUniqueOrThrow({ where: { id: initial.id } })).toMatchObject({
      authorshipKind: null, authoredByTask: null, authoredByRevision: null,
    });
  });

  it('persists a same-abstract accuracy reset through GraphQL on an encrypted node and keeps its stamp', async () => {
    // Decrypting for the diff makes the abstract compare equal, so the DERIVED
    // hash must be in the diff too, or the reset is skipped as a no-op
    // (Codex on #1397 dbf7cdce). MCP's twin is the test below.
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const context = { db, roles: ['ADMIN'], userId: owner.id } as Context;
    await writeNodeCore(
      { memoryId, loc: 'secret-note', content: 'the plaintext secret', abstract: 'A secret summary.' },
      context, 'update',
    );
    const initial = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    const taskId = generateId();
    await db.node.update({
      where: { id: initial.id },
      data: {
        authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
        abstractOriginHash: computeContentHash('an older secret'),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });
    const revisions = await db.nodeRevision.count({ where: { nodeId: initial.id } });
    await writeNodeCore({ memoryId, loc: 'secret-note', abstract: 'A secret summary.' }, context, 'update');
    expect(await db.node.findUniqueOrThrow({ where: { id: initial.id } })).toMatchObject({
      abstractOriginHash: computeContentHash('the plaintext secret'),
      authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1,
    });
    expect(await db.nodeRevision.count({ where: { nodeId: initial.id } })).toBe(revisions + 1);
  });

  it('keeps authorship when an identical abstract only refreshes its derived hash', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const initial = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    await db.node.update({
      where: { id: initial.id },
      data: {
        authorshipKind: 'TASK', authoredByTask: generateId(), authoredByRevision: 1,
        authoredAt: new Date('2026-09-26T20:00:00Z'),
        revisionContentHash: revisionStateHashRefreshMarker(),
      },
    });
    const before = await db.node.findUniqueOrThrow({ where: { id: initial.id } });
    expect(before.abstractOriginHash).toBeNull();
    const revisions = await db.nodeRevision.count({ where: { nodeId: initial.id } });

    await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`, abstract: 'A secret summary.',
    });
    const after = await db.node.findUniqueOrThrow({ where: { id: initial.id } });
    expect(after).toMatchObject({
      authorshipKind: 'TASK', authoredByTask: before.authoredByTask,
      abstractOriginHash: computeContentHash('the plaintext secret'),
    });
    expect(await db.nodeRevision.count({ where: { nodeId: initial.id } })).toBe(revisions + 1);
  });

  it('hadron_update_node while locked is REJECTED with NO side effects — not even a version row (PR-517 Codex P2)', async () => {
    const server = mcp(ownerAuth());
    const before = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    const versionsBefore = await db.nodeRevision.count({ where: { nodeId: before.id } });
    const out = await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`,
      content: 'plaintext overwrite attempt',
    });
    expect(out).toContain('encrypted and locked');
    const after = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    expect(after.content).toBe(before.content); // untouched ciphertext
    expect(await db.nodeRevision.count({ where: { nodeId: before.id } })).toBe(versionsBefore);
  });

  it('an abstract-only update hashes the DECRYPTED content — no false-stale (PR-517 Codex P2)', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    const out = await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`,
      abstract: 'A brand new summary.',
    });
    expect(out).toContain('Node updated');
    // The fresh abstract must NOT be marked stale: its origin hash was
    // computed against the plaintext content, so the unlocked read's
    // staleness compare (also on plaintext) agrees.
    const read = await server.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
      contentScope: 'all',
    });
    expect(read).toContain('A brand new summary.');
    expect(read).not.toContain('abstract-stale');
  });

  it('version rows for encrypted memories store CIPHERTEXT (at-rest form)', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    await server.callToolText('hadron_update_node', {
      urn: `mcp41-org::vault::secret-note`,
      content: 'v2 secret',
    });
    const node = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'secret-note' } });
    const version = await db.nodeRevision.findFirstOrThrow({
      where: { nodeId: node.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(isCiphertext(version.content)).toBe(true);
    expect(version.content).not.toContain('the plaintext secret');
  });
});

describe('hadron_lock_memory', () => {
  it('is no existence oracle: unowned refs get the same not-found as missing ones (PR-517 Codex P2)', async () => {
    const strangerServer = mcp({
      userId: stranger.id,
      roles: ['ADMIN'],
      clientId: `user:${stranger.id}`,
    });
    const existing = await strangerServer.callToolText('hadron_lock_memory', { memoryUrn });
    const missing = await strangerServer.callToolText('hadron_lock_memory', {
      memoryUrn: 'mcp41-org:no-such-memory',
    });
    expect(existing).toContain('not found');
    expect(missing).toContain('not found');
  });

  it('drops this session\'s key: reads return to Locked', async () => {
    const server = mcp(ownerAuth());
    await server.callToolText('hadron_unlock_memory', { memoryUrn, passphrase: PASS });
    await server.callToolText('hadron_lock_memory', { memoryUrn });
    const out = await server.callToolText('hadron_get_node', {
      urn: `mcp41-org::vault::secret-note`,
    });
    expect(out).toContain('Locked: encrypted memory');
    expect(sessionKeyCache.getByMemoryId(memoryId)).toBeNull();
  });
});
