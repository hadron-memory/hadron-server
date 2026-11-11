/** #3705: tree-level type honesty, plus a real planted-cast control. */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/check-null-context.mjs');
function check(root = resolve('src')) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}
it('the production tree has no literal-null Context cast', () => {
  const result = check();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
it.each([
  '({ db, userId: null }) as Context',
  '({ db, userId: null }) as unknown as Context',
  `({ db, ['userId']: (null) }) as unknown as Context`,
])('rejects a planted production cast: %s', expression => {
  const root = mkdtempSync(join(tmpdir(), 'null-context3705-'));
  try {
    writeFileSync(join(root, 'production.ts'), `const context = ${expression};`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production.ts:1: null userId cast to Context');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('ignores test-only casts, prose, other row types, and honest user contexts', () => {
  const root = mkdtempSync(join(tmpdir(), 'null-context3705-'));
  try {
    writeFileSync(join(root, 'production.ts'), `
      // ({ userId: null }) as Context
      const prose = '({ userId: null }) as Context';
      const row = ({ userId: null }) as Row;
      const ctx = ({ userId: undefined }) as Context;
    `);
    writeFileSync(join(root, 'defense.test.ts'), 'const ctx = ({ userId: null }) as unknown as Context;');
    expect(check(root).status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
