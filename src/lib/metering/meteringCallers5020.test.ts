/**
 * hadron-server#5020 (Billing A13): the guard over every caller of `recordLlmUsage`. A unit of AI spend names exactly one
 * billable account, the owner of the work (hrn:node:hadronmemory.com:specs:cor:dmo:170:05, S4: the guard lists every
 * caller so none records an unbillable unit). Each caller is listed with how it names the account; a call site in the
 * source that is not listed fails the test, and so does a listed one that is gone or whose count changed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The call sites under `src` (not tests, not the definition), and how each names the billable account. */
const CALLERS: Record<string, { calls: number; billableAccount: string }> = {
  'src/jobs/appRuns.ts': {
    calls: 1,
    billableAccount: 'the run hop: the owner of the App the run is in, which is the run\'s own organization (spec S3: never the Agent\'s owner)',
  },
  'src/jobs/embedNodes.ts': {
    calls: 1,
    billableAccount: 'embedding: the memory\'s organization, none for a memory a person owns (attribution unchanged until section 13 item 3 is ruled); never debited (NEVER_DEBITED_TYPES)',
  },
  'src/controller/operations/testAiServiceConfig.ts': {
    calls: 2,
    billableAccount: 'the two configuration tests: billableAccountOfConfig, the owner of the config (its organization, else its App\'s or Agent\'s owner, else nobody); never the caller\'s active organization',
  },
};

const SRC = join(__dirname, '..', '..');
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes(`${join('src', 'generated')}`)) out.push(p);
  }
  return out;
}
const rel = (p: string) => p.slice(join(SRC, '..').length + 1);

describe('#5020 pin 11: every caller of recordLlmUsage names its billable account', () => {
  const found = new Map<string, number>();
  for (const file of sources(SRC)) {
    if (rel(file) === 'src/lib/metering/index.ts') continue; // the definition
    const n = (readFileSync(file, 'utf8').match(/\brecordLlmUsage\s*\(/g) ?? []).length;
    if (n > 0) found.set(rel(file), n);
  }

  it('the call sites in the source are exactly the listed ones, with the listed counts', () => {
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(CALLERS).map(([f, c]) => [f, c.calls])));
  });

  it('each call passes billableAccount and none passes a bare organizationId', () => {
    for (const file of Object.keys(CALLERS)) {
      const text = readFileSync(join(SRC, '..', file), 'utf8');
      const calls = text.split(/\brecordLlmUsage\s*\(/).slice(1);
      for (const rest of calls) {
        // the call's argument object ends at its first line of the form `});` at the call's own indentation
        const body = rest.slice(0, rest.search(/\n\s*\}\);/));
        expect(body, file).toMatch(/\bbillableAccount\b/);
        expect(body, file).not.toMatch(/^\s*organizationId:/m);
      }
    }
  });

  it('every listed caller states how it names the account', () => {
    for (const [file, c] of Object.entries(CALLERS)) expect(c.billableAccount.length, file).toBeGreaterThan(20);
  });
});
