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

  it('Production DB section names the URL for each procedure and what is not done', () => {
    const prod = section(doc, 'Production DB (alpha)');
    for (const procedure of ['prisma migrate deploy', 'prisma migrate resolve', 'ALTER', 'runtime-role.sql', 'verify-runtime-role', 'dev-from-prod-snapshot']) {
      expect(prod, procedure).toContain(procedure);
    }
    expect(prod).toContain('printenv MIGRATE_DATABASE_URL');
    expect(prod).toMatch(/R1[^\n]*NOT done/);
    expect(prod).toMatch(/R4[^\n]*NOT done/);
    expect(prod).toMatch(/register grant/i);
  });

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
