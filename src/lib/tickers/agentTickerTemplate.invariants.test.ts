/** #2024 (S8): the template invariants file, its migration copy and post-push stay one source. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../../../prisma/${rel}`, import.meta.url), 'utf8');

describe('agent-ticker-template-invariants.sql (#2024)', () => {
  it('the migration is plain SQL that ends with a byte-identical copy of the invariants file', () => {
    const source = read('agent-ticker-template-invariants.sql');
    const migration = read('migrations/20261024120000_agent_ticker_templates/migration.sql');
    expect(migration.endsWith(source)).toBe(true);
    // A tool message pasted in by a generator (no DATABASE_URL, a config banner) is not SQL.
    expect(migration.split('\n')[0]).toMatch(/^(-- |ALTER TABLE |CREATE |DROP )/);
    expect(migration).not.toMatch(/Failed to load|Loaded Prisma config|PrismaConfigEnvError/);
  });

  it('post-push.sql includes the invariants file', () => {
    expect(read('post-push.sql')).toContain('\\ir agent-ticker-template-invariants.sql');
  });
});
