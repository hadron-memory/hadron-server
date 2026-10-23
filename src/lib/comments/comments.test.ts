/** #1606 — the published comment fixture and the shared invariants SQL stay true to the code. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { computeApprovalHash } from '../approvalHash.js';
import { runAsActor } from '../requestActor.js';
import { assertNotCommentWrite, authorKeyOf, parseAuthorKey, validateBody, validateQuote, type CommentRefusalCode } from './index.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const fixture = JSON.parse(read('./comment.fixture.json'));

describe('comment.fixture.json (contract §7)', () => {
  it.each(fixture.authorKeys as any[])('author key: $name', async (row: any) => {
    const { workerId, agentId, userId, appId } = row.principal;
    const key = await runAsActor({ workerId, agentId }, () => authorKeyOf({ userId, appId }));
    expect(key).toBe(row.authorKey);
    if (key) expect(parseAuthorKey(key).kind).toBe(row.kind);
  });

  it('anchor hash is approval hash v1 over the target revision', () => {
    expect(computeApprovalHash(fixture.anchorHash.input)).toBe(fixture.anchorHash.anchorApprovalHash);
  });

  it('lists every comment refusal code the code can raise', () => {
    // A compile-time list: adding a code to CommentRefusalCode without adding
    // it here (and so to the fixture) fails to type-check.
    const codes: Record<CommentRefusalCode, true> = {
      COMMENT_TARGET_NOT_FOUND: true, COMMENT_NOT_FOUND: true, COMMENT_FORBIDDEN: true,
      COMMENT_TARGET_IS_COMMENT: true, COMMENT_MEMORY_NOT_COMMENTABLE: true, COMMENT_OPEN_THREAD_EXISTS: true,
      COMMENT_ANCHOR_REVISION_INVALID: true, COMMENT_ANCHOR_REVISION_UNAVAILABLE: true, COMMENT_NOT_AUTHOR: true,
      COMMENT_DELETED: true, COMMENT_NOT_TOP_LEVEL: true, COMMENT_THREAD_STATE: true,
      COMMENT_ADMIN_REQUIRED: true, COMMENT_IMPERSONATION_REFUSED: true, COMMENT_BODY_INVALID: true,
      COMMENT_MOVE_UNCOMMENTABLE: true, COMMENT_MERGE_FOLDS_THREADS: true, COMMENT_NOT_APPROVABLE: true,
    };
    const published = new Set(fixture.errors.map((e: { code: string }) => e.code));
    for (const code of Object.keys(codes)) expect(published).toContain(code);
  });
});

describe('validation and the generic-path gate', () => {
  it('bodies and quotes', () => {
    expect(validateBody('x')).toBe('x');
    expect(() => validateBody(' \n ')).toThrow(/empty/);
    expect(validateQuote('  ')).toBeNull();
    expect(validateQuote(undefined)).toBeNull();
  });

  it('refuses producing, removing and editing a comment; leaves other writes alone', () => {
    expect(() => assertNotCommentWrite(null, 'comment', 'create')).toThrow(/ROLE_GOVERNED/);
    expect(() => assertNotCommentWrite('comment', 'info', 'update')).toThrow(/turn a comment into/);
    expect(() => assertNotCommentWrite('comment', undefined, 'update')).toThrow(/change a comment/);
    expect(() => assertNotCommentWrite('info', 'task', 'update')).not.toThrow();
    expect(() => assertNotCommentWrite(undefined, undefined, 'create')).not.toThrow();
  });
});

describe('prisma/comment-invariants.sql', () => {
  it('is copied verbatim into the migration (prod does not run post-push.sql)', () => {
    const invariants = read('../../../prisma/comment-invariants.sql');
    const dir = fileURLToPath(new URL('../../../prisma/migrations/', import.meta.url));
    // The newest comment migration carries the current text (#2040).
    const migration = readdirSync(dir)
      .filter((d) => /_(comment_(nodes|rulings)|encrypted_comment_anchor_nullable|encrypted_anchor_hash_scrub|system_memories_commentable|include_edges_lifecycle)$/.test(d)).sort().at(-1)!;
    expect(migration).toMatch(/_include_edges_lifecycle$/);
    expect(read(`../../../prisma/migrations/${migration}/migration.sql`)).toContain(invariants);
    expect(read('../../../prisma/post-push.sql')).toContain('\\ir comment-invariants.sql');
  });
});
