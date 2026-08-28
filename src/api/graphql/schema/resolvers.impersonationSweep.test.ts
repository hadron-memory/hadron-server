/**
 * #876 cross-cutting guard — keeps the impersonation sweep from rotting.
 *
 * The security review's root finding was a CLASS, not four instances: a
 * resolver that authorizes on `ctx.userId` as an owner/creator grants an
 * impersonated session identity-scoped access unless it also consults
 * `ctx.impersonation`. Fixing the known ones is a snapshot; this test is what
 * makes the rule stick.
 *
 * The check is deliberately coarse — file-level, not line-level — because a
 * precise one would be brittle. If a read module grows an identity predicate,
 * that FILE must also mention `ctx.impersonation` somewhere. That forces a
 * conscious decision (guard it, or add it to the allowlist below with a
 * reason) instead of the surface leaking silently, which is exactly how all
 * four #876 bypasses shipped.
 *
 * This cannot prove the guard is in the RIGHT place — only that the module's
 * author considered impersonation at all. The per-surface assertions in
 * resolvers.impersonation.test.ts are the real behavioural proof.
 *
 * KNOWN BLIND SPOT, stated because this file otherwise reads as broader
 * coverage than it has (#1094). A SHARED PREDICATE in a module that already
 * mentions `ctx.impersonation` is invisible here: `resolvers.helpers.ts`
 * mentions it a dozen times, so `isAppParticipant` shipped with an unguarded
 * AppMember arm and this sweep stayed green — the fifth #876 instance, and the
 * first inside a predicate rather than a resolver. Making the check line-level
 * would catch it and is exactly the brittleness rejected above, so the coverage
 * for that class is behavioural instead: a case per PREDICATE in
 * resolvers.impersonation.test.ts (see the #1094 block), not per module.
 * When you add a shared authorization predicate, that is where it belongs —
 * a green run here says nothing about it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SCHEMA_DIR = join(import.meta.dirname, '.');

/**
 * Predicates that authorize/filter on the caller's identity as an owner or
 * creator — the shape that silently re-points at the target under
 * impersonation. (`organizationId: ..., userId: ctx.userId` membership lookups
 * are org-derived and safe, so the bare-`userId` pattern is matched only when
 * it is not part of a membership where-clause; the file-level granularity
 * makes that distinction unnecessary in practice.)
 */
const IDENTITY_PREDICATES = [
  /ownerUserId:\s*ctx\.userId/,
  /createdBy:\s*ctx\.userId/,
  /granteeId:\s*ctx\.userId/,
  /grantedByUserId:\s*ctx\.userId/,
  /principalId\s*=\s*ctx\.userId/,
  /uploadedBy:\s*ctx\.userId/,
];

/**
 * `resolvers.mutation.*` is skipped categorically: the read-only plugin
 * rejects every mutation for an impersonated session, so an identity
 * predicate there is unreachable rather than merely unguarded.
 */
const MUTATION_MODULE = /^resolvers\.mutation\./;

/**
 * Mixed read/write modules whose identity predicates are audit-actor STAMPS
 * on writes (`createdBy` in a `data` payload — recording who acted) rather
 * than read authorization (`createdBy` in a `where` clause — filtering by
 * creator). The stamps sit on mutations the plugin blocks, and each module's
 * READ paths are org-gated via requireOrgRole / requireOwnerOrOrgRole, which
 * the feature narrowed. Each entry needs a reason: an empty allowlist would
 * be ideal, but an explicit justified one beats a silently wrong rule.
 */
const ALLOWLIST: Record<string, string> = {
  'resolvers.appRun.ts':
    'createdBy is an audit-actor stamp on run writes (plugin-blocked); appRuns/appRun/latestAppRun reads are org-gated',
  'resolvers.metering.ts':
    'createdBy is an audit-actor stamp on grantCredits/setAiModelPrice (platform-admin mutations); price + ledger reads are org-derived',
};

describe('#876 — identity-keyed resolver modules must consider impersonation', () => {
  const files = readdirSync(SCHEMA_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !MUTATION_MODULE.test(f),
  );

  const offenders: { file: string; predicate: string }[] = [];
  for (const file of files) {
    if (file in ALLOWLIST) continue;
    const source = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    const hit = IDENTITY_PREDICATES.find((re) => re.test(source));
    if (hit && !source.includes('ctx.impersonation')) {
      offenders.push({ file, predicate: String(hit) });
    }
  }

  it('every module with an owner/creator identity predicate consults ctx.impersonation', () => {
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These modules authorize on the caller's identity but never mention ctx.impersonation, ` +
          `so an impersonated session would be authorized as the TARGET (#876):\n` +
          offenders.map((o) => `  - ${o.file} (matched ${o.predicate})`).join('\n') +
          `\n\nGuard the surface (see resolvers.query.chat.ts) or add it to ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it('the allowlist stays justified (every entry names a real file and a reason)', () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(files, `allowlisted file no longer exists: ${file}`).toContain(file);
      expect(reason.length, `allowlist entry ${file} needs a reason`).toBeGreaterThan(10);
    }
  });
});
