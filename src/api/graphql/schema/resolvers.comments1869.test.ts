/**
 * #1869 — the one-time scrub of anchor hashes on comments whose target is in an
 * encrypted memory (cor:dmo:110:01; Holger, team chat #10549), and the insert
 * check that makes "hash present exactly when the target is plaintext" a
 * database invariant (Rook's #1866 P3-3).
 *
 * The scrub pins run the real migration file, as `prisma migrate deploy` does:
 * one multi-statement script on its own connection.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const MIGRATION = read('../../../../prisma/migrations/20261013180000_encrypted_anchor_hash_scrub/migration.sql');
const INVARIANTS = read('../../../../prisma/comment-invariants.sql');

let admin: { id: string };
let orgId: string;

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

const memoryNamed = (name: string) => M.createMemory(null, { orgId, name }, as()) as Promise<{ id: string }>;
const node = (memoryId: string, loc: string) => db.node.create({
  data: { id: generateId(), memoryId, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: `Body ${loc}` },
});
const comment = async (memoryId: string, loc: string) => {
  const target = await node(memoryId, loc);
  return { target, comment: await M.createComment(null, { targetRef: target.id, body: 'Looks off' }, as()) as { id: string; revSeq: number } };
};
/** A memory encrypted in place AFTER its comments were written: the legacy rows #1869 is about. */
const encryptInPlace = (memoryId: string) =>
  db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true, vectorIndexEnabled: false } });
const anchorOf = (commentId: string) => db.edge.findFirstOrThrow({ where: { sourceId: commentId, governedKind: 'COMMENT_ANCHOR' } });

/** Whole rows as the database stores them, so "untouched" means every column. */
const rawEdges = async () => (await db.$queryRawUnsafe<{ id: string; row: Record<string, unknown> }[]>(
  `SELECT id, to_jsonb(e) AS row FROM edges e WHERE governed_kind IS NOT NULL ORDER BY id`,
)).map(({ id, row }) => [id, row] as const);
const rawComments = () => db.$queryRawUnsafe<unknown[]>(
  `SELECT to_jsonb(n) AS node, to_jsonb(cm) AS meta FROM nodes n JOIN comment_meta cm ON cm.node_id = n.id ORDER BY n.id`,
);
const guardDefinition = async () => (await db.$queryRawUnsafe<{ def: string }[]>(
  `SELECT pg_get_functiondef('hadron_edges_governed_immutable'::regproc) AS def`,
))[0].def;

/** Run the migration file on its own connection; returns the scrub's row count. */
const migrate = async (): Promise<number> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const results = await client.query(MIGRATION) as unknown as { command: string; rowCount: number | null }[];
    // The replay installs the invariants as they stood at #1869; restore the
    // current ones, as the later migrations do in prod, so no later test file
    // on this worker's database runs against a stale check (#1935).
    await client.query(INVARIANTS);
    const updates = results.filter((r) => r.command === 'UPDATE');
    expect(updates).toHaveLength(1);
    return updates[0].rowCount ?? 0;
  } finally {
    await client.end();
  }
};
/** The scrub's own write, attempted outside the migration. */
const scrubOutside = (edgeId: string) =>
  db.$executeRawUnsafe(`UPDATE edges SET anchor_approval_hash = NULL WHERE id = $1`, edgeId);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Comment Org 1869', urn: 'comment-1869.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 186901, githubUsername: 'cm-admin', handle: 'cm-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});

describe('the #1869 scrub migration', () => {
  it('clears the hash of every encrypted-target anchor and changes nothing else', async () => {
    const plain = await memoryNamed('plain');
    const enc = await memoryNamed('enc');
    const p = await comment(plain.id, 'p:1');
    const e1 = await comment(enc.id, 'e:1');
    const e2 = await comment(enc.id, 'e:2');
    await M.replyToComment(null, { commentRef: e1.comment.id, body: 'a reply' }, as());
    // A deleted thread keeps its anchor, and its hash is scrubbed too.
    await M.deleteComment(null, { commentRef: e2.comment.id, expectedRevision: e2.comment.revSeq }, as());
    await encryptInPlace(enc.id);

    const before = new Map(await rawEdges());
    const commentsBefore = await rawComments();
    expect((await anchorOf(e1.comment.id)).anchorApprovalHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await migrate()).toBe(2);

    const after = new Map(await rawEdges());
    expect([...after.keys()]).toEqual([...before.keys()]);
    const scrubbed = new Set([(await anchorOf(e1.comment.id)).id, (await anchorOf(e2.comment.id)).id]);
    for (const [id, row] of after) {
      if (scrubbed.has(id)) {
        // Only the hash went: the anchor revision and every other column stay.
        expect(row).toEqual({ ...before.get(id), anchor_approval_hash: null });
        expect(row.anchor_rev_no).toBe(1);
      } else {
        expect(row).toEqual(before.get(id)); // the plaintext anchor and the reply edge
      }
    }
    expect((await anchorOf(p.comment.id)).anchorApprovalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await rawComments()).toEqual(commentsBefore);
  });

  it('is idempotent: a second run matches no row and changes nothing', async () => {
    const enc = await memoryNamed('enc');
    await comment(enc.id, 'e:1');
    await encryptInPlace(enc.id);
    expect(await migrate()).toBe(1);
    const once = await rawEdges();
    expect(await migrate()).toBe(0);
    expect(await rawEdges()).toEqual(once);
  });

  // The security heart (Xylon's gate): the exception exists only inside the
  // migration's transaction.
  it('leaves the canonical guard behind: the same write is refused before and after it', async () => {
    const enc = await memoryNamed('enc');
    const early = await comment(enc.id, 'e:1');
    await encryptInPlace(enc.id);
    const guard = await guardDefinition();
    const earlyAnchor = await anchorOf(early.comment.id);
    await expect(scrubOutside(earlyAnchor.id)).rejects.toThrow(/governed comment edge .* is immutable/);
    expect((await anchorOf(early.comment.id)).anchorApprovalHash).toBe(earlyAnchor.anchorApprovalHash);

    await migrate();
    expect(await guardDefinition()).toBe(guard);

    // A memory encrypted after the migration keeps its row (a migration-time
    // snapshot, not a standing sweep), and the scrub's write is refused for it.
    const later = await memoryNamed('later');
    const late = await comment(later.id, 'l:1');
    await encryptInPlace(later.id);
    const lateAnchor = await anchorOf(late.comment.id);
    expect(lateAnchor.anchorApprovalHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(scrubOutside(lateAnchor.id)).rejects.toThrow(/governed comment edge .* is immutable/);
    expect((await anchorOf(late.comment.id)).anchorApprovalHash).toBe(lateAnchor.anchorApprovalHash);
  });

  it('the temporary guard is the canonical one plus exactly the scrub transition', () => {
    const fn = (sql: string) => {
      const start = sql.indexOf('CREATE OR REPLACE FUNCTION hadron_edges_governed_immutable()');
      return sql.slice(start, sql.indexOf('END $$;', start) + 'END $$;'.length);
    };
    const temporary = fn(MIGRATION);
    const scrubBranch = temporary.slice(temporary.indexOf("  IF TG_OP = 'UPDATE'\n     AND"), temporary.indexOf("  IF TG_OP = 'UPDATE' THEN"));
    expect(scrubBranch).toContain('RETURN NEW;');
    // The guard as it stood when this migration was written: the newest copy of
    // the invariants before #2040 widened the kinds (an applied migration never changes).
    const guardAtScrub = read('../../../../prisma/migrations/20261015100000_system_memories_commentable/migration.sql');
    expect(temporary.replace(scrubBranch, '')).toBe(fn(guardAtScrub));
    // Step 3 re-applies the canonical text after the scrub and before COMMIT:
    // the file as it stood then, since an applied migration never changes
    // (#1935 has since widened the class check, in its own migration).
    const header = INVARIANTS.slice(0, INVARIANTS.indexOf('\n'));
    expect(MIGRATION.indexOf(header)).toBeGreaterThan(MIGRATION.indexOf('UPDATE "edges"'));
    expect(MIGRATION.trimEnd().endsWith('COMMIT;')).toBe(true);
    // A re-run on every schema sync would sweep memories encrypted later.
    expect(read('../../../../prisma/post-push.sql')).not.toContain('encrypted_anchor_hash_scrub');
  });
});

describe('an anchor is born with a hash exactly when its target is plaintext (P3-3)', () => {
  /** A whole comment written below the resolver (node, meta, its one anchor), so only the hash rule decides. */
  const rawComment = (target: { id: string; memoryId: string }, hash: string | null) => db.$transaction(async (tx) => {
    const id = generateId();
    await tx.node.create({ data: { id, memoryId: target.memoryId, loc: `comment-${id}`, name: 'Comment', nodeType: 'comment', content: 'x' } });
    await tx.commentMeta.create({ data: { nodeId: id, targetNodeId: target.id, threadState: 'OPEN', authorKey: `u:${admin.id}` } });
    await tx.edge.create({ data: {
      memoryId: target.memoryId, sourceId: id, targetId: target.id, loc: `comment-${id}-anchor`,
      name: 'comment-anchor', governedKind: 'COMMENT_ANCHOR', anchorRevNo: 1, anchorApprovalHash: hash,
    } });
    return id;
  });
  const HASH = 'a'.repeat(64);

  it('refuses a hash on an encrypted target, and admits the revision-only anchor', async () => {
    const enc = await memoryNamed('enc');
    const target = await node(enc.id, 'e:1');
    await encryptInPlace(enc.id);
    await expect(rawComment(target, HASH)).rejects.toThrow(/carries a hash, but its target is in an encrypted memory/);
    await expect(rawComment(target, null)).resolves.toBeTruthy();
  });

  it('refuses a missing hash on a plaintext target, and admits the hashed anchor', async () => {
    const plain = await memoryNamed('plain');
    const target = await node(plain.id, 'p:1');
    await expect(rawComment(target, null)).rejects.toThrow(/has no hash, but its target is in a plaintext memory/);
    await expect(rawComment(target, HASH)).resolves.toBeTruthy();
  });
});
