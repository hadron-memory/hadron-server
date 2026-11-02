/** #2447 (#2413 S4): the agent guides must state the two-URL boot as merged, per procedure. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const section = (doc: string, heading: string) => {
  const start = doc.indexOf(`## ${heading}`);
  expect(start, `${heading} section exists`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next < 0 ? undefined : next);
};

describe.each(['CLAUDE.md', 'AGENTS.md'])('%s', (file) => {
  const doc = read(file);

  it('has an env-table row for MIGRATE_DATABASE_URL that states the unset fallback and the verify exits', () => {
    const row = doc.split('\n').find((l) => l.startsWith('| `MIGRATE_DATABASE_URL`'));
    expect(row).toBeDefined();
    expect(row).toContain('db.runtime_role.owner_serving');
    expect(row).toContain('RUNTIME_ROLE_NAME');
    expect(row).toContain('scripts/docker-start.sh');
  });

  it('says DATABASE_URL is the serve credential and where the owner URL is used', () => {
    const row = doc.split('\n').find((l) => l.startsWith('| `DATABASE_URL`'))!;
    expect(row).toMatch(/serve/i);
    expect(row).toContain('MIGRATE_DATABASE_URL');
  });

  // #2657: CLAUDE.md (a public file) no longer carries the production recipe, the
  // URL-per-procedure table or the cutover state; they live in the ops node it links to.
  // AGENTS.md has not been moved yet, so it keeps the original per-procedure assertions.
  if (file === 'CLAUDE.md') {
    it('Production database section links the ops node and keeps the guardrails', () => {
      const prod = section(doc, 'Production database');
      expect(prod).toContain('hrn:node:hadronmemory.com:dev:ops:alpha:db-access');
      for (const kept of ['scripts/docker-start.sh', 'runtime-role.sql', 'serve-role-smoke', 'MIGRATE_DATABASE_URL']) {
        expect(prod, kept).toContain(kept);
      }
      expect(prod).toMatch(/register grant/i);
      expect(prod).toMatch(/never put the owner URL into `DATABASE_URL`/i);
      expect(prod).toMatch(/as the owner, never as the superuser/i);
    });
    it('does not carry the production access recipe or the cutover state any more', () => {
      expect(doc).not.toContain('printenv MIGRATE_DATABASE_URL');
      expect(doc).not.toMatch(/ssh root@/);
      expect(doc).not.toMatch(/R1[\s\S]{0,120}NOT done/);
    });
  } else {
    it('Production DB section names the URL for each procedure and what is not done', () => {
      const prod = section(doc, 'Production DB (alpha)');
      for (const procedure of ['prisma migrate deploy', 'prisma migrate resolve', 'ALTER', 'runtime-role.sql', 'verify-runtime-role', 'dev-from-prod-snapshot']) {
        expect(prod, procedure).toContain(procedure);
      }
      expect(prod).toContain('printenv MIGRATE_DATABASE_URL');
      expect(prod).toMatch(/R1[\s\S]{0,120}NOT done/);
      expect(prod).toMatch(/R4[\s\S]{0,120}NOT done/);
      expect(prod).toMatch(/register grant/i);
    });
  }

  it('never shows the owner URL being placed in the serve slot', () => {
    expect(doc).not.toMatch(/DATABASE_URL=["']?\$\{?MIGRATE_DATABASE_URL/);
    expect(doc).not.toMatch(/(?<!MIGRATE_)DATABASE_URL=\$\(.*printenv MIGRATE_DATABASE_URL/);
  });

  it('Local Postgres section says local dev stays single-role', () => {
    const local = section(doc, 'Local Postgres setup');
    expect(local).toContain('MIGRATE_DATABASE_URL');
    expect(local).toMatch(/single[- ]role/i);
  });
});

it('.env.example documents MIGRATE_DATABASE_URL as optional and commented out', () => {
  const env = read('.env.example');
  expect(env).toMatch(/^# MIGRATE_DATABASE_URL=/m);
  expect(env).not.toMatch(/^MIGRATE_DATABASE_URL=/m);
});
