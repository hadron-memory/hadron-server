/**
 * #1370 ratchet: every `orgMember` read must consider the ORG's liveness, or be
 * an explicitly listed exception.
 *
 * A deleted org's former members kept their role at every gate because each
 * membership read checked only the membership row's `deletedAt`. The fix put
 * one predicate (`LIVE_ORG_MEMBERSHIP`) into each authorizing or enumerating
 * read. This test keeps it that way: a new `orgMember` read that authorizes
 * without org liveness fails here, instead of silently reopening the hole.
 *
 * An exception is keyed by file, enclosing function and a distinctive fragment
 * of its arguments, so a SECOND, authorizing read added to the same function is
 * still caught.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Reads that manage or clean up membership ROWS, which must see dead orgs' rows too. */
const EXEMPT: Array<{ file: string; fn: string; fragment: string; why: string }> = [
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'acceptInvitation', fragment: 'organizationId_userId', why: 'upsert of the invitee row; the invite path checks the org itself' },
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'acceptInvitation', fragment: 'userId: invite.senderUserId', why: 'inviter authority recheck inside an org-anchored transaction that verifies org liveness' },
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'addOrgMember', fragment: 'organizationId_userId', why: 'target-row lookup behind requireOrgRole, which refuses a dead org' },
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'updateOrgMember', fragment: "role: 'OWNER'", why: 'last-owner count behind requireOrgRole' },
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'removeOrgMember', fragment: 'organizationId_userId', why: 'target-row lookup behind requireOrgRole' },
  { file: 'src/api/graphql/schema/resolvers.mutation.org.ts', fn: 'removeOrgMember', fragment: "role: 'OWNER'", why: 'last-owner count behind requireOrgRole' },
  { file: 'src/api/graphql/schema/resolvers.impersonation.ts', fn: 'startImpersonation', fragment: 'userId: targetId', why: "the TARGET's role, read after the caller's live-org gate" },
  { file: 'src/api/graphql/schema/resolvers.types.ts', fn: 'isOrgExternal', fragment: 'userId: s.userId', why: 'classification of another user, paired with isOrgExternalAppMember' },
  { file: 'src/lib/auth/isOrgExternalAppMember.ts', fn: 'isOrgExternalAppMember', fragment: 'userId: args.userId', why: 'classification, paired with Member.isOrgExternal' },
  { file: 'src/controller/operations/deleteUser.ts', fn: 'membershipScope', fragment: 'userId: targetUserId, deletedAt: null', why: 'account deletion pre-reads every membership to lock its org anchor' },
  { file: 'src/controller/operations/deleteUser.ts', fn: 'freshScope', fragment: 'userId: targetUserId, deletedAt: null', why: 'account deletion checks the anchored membership scope, then sweeps every membership' },
  { file: 'src/controller/operations/deleteUser.ts', fn: 'freshScope', fragment: 'userId: { not: targetUserId }, deletedAt: null', why: 'account deletion: other members of an already verified live org' },
  { file: 'src/controller/operations/deleteUser.ts', fn: 'freshScope', fragment: "role: 'OWNER'", why: 'account deletion: other owners of an already verified live org' },
];

// Whitespace and newlines may separate the client property from the method
// (`ctx.db.orgMember\n  .findMany(`): a single-line pattern let two
// authorizing reads in userVisibility.ts slip past (@codex P2 on #1539).
const READ = /orgMember\s*\.\s*(findFirst|findMany|findUnique|findUniqueOrThrow|findFirstOrThrow|count)\s*\(/g;

function enclosingFunction(text: string, offset: number): string {
  const lines = text.slice(0, offset).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
      ?? lines[i].match(/^\s{2,6}(\w+):\s*async/)
      ?? lines[i].match(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) return m[1];
  }
  return '?';
}

/** The call's argument text: from the read to its balanced closing paren. */
function callArgs(text: string, from: number): string {
  let depth = 0;
  for (let i = text.indexOf('(', from); i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

describe('#1370 ratchet: orgMember reads carry org liveness', () => {
  it('every non-test orgMember read uses LIVE_ORG_MEMBERSHIP or is a listed exception', () => {
    const files = execFileSync('git', ['ls-files', 'src/*.ts'], { encoding: 'utf8' })
      .split('\n').filter((f) => f && !f.endsWith('.test.ts'));
    const offenders: string[] = [];
    const usedExemptions = new Set<number>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(READ)) {
        const args = callArgs(text, m.index!);
        if (args.includes('LIVE_ORG_MEMBERSHIP') || /organization:\s*\{\s*deletedAt:\s*null/.test(args)) continue;
        const fn = enclosingFunction(text, m.index!);
        const ex = EXEMPT.findIndex((e) => e.file === file && e.fn === fn && args.includes(e.fragment));
        if (ex >= 0) { usedExemptions.add(ex); continue; }
        offenders.push(`${file}:${text.slice(0, m.index!).split('\n').length} [${fn}]`);
      }
    }
    expect(offenders, 'authorizing orgMember reads without org liveness (#1370)').toEqual([]);
    // A stale exception (its read was removed or fixed) must be deleted, so the list stays honest.
    const stale = EXEMPT.filter((_, i) => !usedExemptions.has(i)).map((e) => `${e.file}#${e.fn} (${e.fragment})`);
    expect(stale, 'exemptions that no longer match any read').toEqual([]);
  });
});
