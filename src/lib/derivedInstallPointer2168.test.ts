/** #2168: schema-push and production migration must enforce the same pointer pair. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('ships the derived pointer invariant identically in replay and schema-push', () => {
  const root = new URL('../../prisma/', import.meta.url);
  const guard = readFileSync(new URL('derived-install-prompt-pointer-invariants.sql', root), 'utf8');
  const migration = readFileSync(new URL('migrations/20261104123000_derived_install_prompt_pointer/migration.sql', root), 'utf8');
  expect(migration.endsWith(guard)).toBe(true);
  expect(readFileSync(new URL('post-push.sql', root), 'utf8')).toContain(String.raw`\ir derived-install-prompt-pointer-invariants.sql`);
});
