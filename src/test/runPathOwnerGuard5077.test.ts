/**
 * hadron-server#5077 (Billing F3a, step 9; finding hrn:node:hadronmemory.com:hadron-server:findings:org-xor-owner-null-comparison-bypass):
 * a source guard that keeps the nullable organization id off the run path. A run of an App a person owns has
 * `organizationId` null, so on this path a read of `run.organizationId`, `args.organizationId` or `parent.organizationId`
 * is either a filter that becomes `IS NULL` (every person's rows) or a comparison that passes on two nulls. The run path
 * takes the run's owner instead (`requireOwnerRefOf(run)`, `ownedBy`, `isOwnedBy`, `orgIdOf`).
 *
 * Every remaining hit is in the allowlist below with its reason, and an allowlist entry that no longer matches fails too,
 * so the list cannot go stale.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return walk(rel);
    return rel.endsWith('.ts') && !rel.endsWith('.test.ts') ? [rel] : [];
  });
}

/** The run path: mint and the hop loop, the runner's dependencies and helpers, the consent capture, includes, secret use, the run principal. */
const FILES = [
  'src/jobs/appRuns.ts',
  'src/jobs/appRunDeps.ts',
  ...walk('src/lib/runner'),
  ...walk('src/lib/automation'),
  ...walk('src/lib/includes'),
  'src/lib/secrets/readClientReveal.ts',
  'src/lib/auth/runPrincipal.ts',
  'src/lib/auth/runTeamRead.ts',
];

/** A read of a run's, mint argument's or parent run's nullable organization id. */
const NULLABLE_READ = /\b(run|args|parent)\.organizationId\b/;
/** `===` / `!==` between two organization ids (either spelling), the comparison that passes on two nulls. */
const NULLABLE_COMPARE = /organization(Id|_id)\s*(===|!==)\s*[\w.!?()]*organization(Id|_id)/;

/** Each entry: the file, a substring of the one line it allows, and why it is safe. */
const ALLOW: Array<{ file: string; line: string; reason: string }> = [
  {
    file: 'src/lib/auth/runPrincipal.ts',
    line: 'organizationId: run.organizationId ?? undefined',
    reason: 'The run principal carries no organization for a person\'s run (undefined, as that App\'s key has), never null; no memory gate filters by it.',
  },
  {
    file: 'src/lib/automation/versions.ts',
    line: 'current.organizationId !== observed.organizationId || current.ownerUserId !== observed.ownerUserId',
    reason: 'A re-read of the SAME App row compared with itself on both owner columns (change detection, not a match across two owners); the owner XOR CHECK rules out a row with neither.',
  },
  {
    file: 'src/lib/auth/runTeamRead.ts',
    line: "app.organizationId === run!.organization_id) && run!.organization_id === ctx.organizationId",
    reason: 'Unchanged and pinned (issue Q6, a follow-up): the line before refuses a principal with no organization, so a person\'s run never reaches this comparison.',
  },
];

describe('#5077 run-path source guard: no nullable organization id on the run path', () => {
  const hits = FILES.flatMap((file) => readFileSync(join(ROOT, file), 'utf8').split('\n').flatMap((text, i) =>
    (NULLABLE_READ.test(text) || NULLABLE_COMPARE.test(text)) && !text.trim().startsWith('//') && !text.trim().startsWith('*')
      ? [{ file, lineNo: i + 1, text: text.trim() }] : []));

  it('every read or comparison of a nullable organization id on the run path is allowlisted with a reason', () => {
    const unexplained = hits.filter((h) => !ALLOW.some((a) => a.file === h.file && h.text.includes(a.line)));
    expect(unexplained.map((h) => `${h.file}:${h.lineNo}: ${h.text}`)).toEqual([]);
  });

  it('every allowlist entry still matches a line (no stale entries)', () => {
    const stale = ALLOW.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.line)));
    expect(stale.map((a) => `${a.file}: ${a.line}`)).toEqual([]);
  });

  it('the guard sees what it is meant to see (detector self-check)', () => {
    expect(NULLABLE_READ.test('where: { organizationId: run.organizationId }')).toBe(true);
    expect(NULLABLE_READ.test('ctx.run.organizationId')).toBe(true);
    expect(NULLABLE_READ.test('args.organizationId')).toBe(true);
    expect(NULLABLE_COMPARE.test('memory.organizationId !== auth.organizationId')).toBe(true);
    expect(NULLABLE_COMPARE.test('memory.organizationId === run.organization_id')).toBe(true);
    expect(NULLABLE_READ.test('requireOwnerRefOf(run)')).toBe(false);
    expect(FILES.length).toBeGreaterThan(20);
  });
});
