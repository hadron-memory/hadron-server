import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fixtureSql } from './scale-fixture.mjs';

test('deterministic bounded program does not materialize a million-row host artifact', () => {
  const first = fixtureSql(1_000_000, 'test-seed');
  assert.equal(first, fixtureSql(1_000_000, 'test-seed'));
  assert.notEqual(first, fixtureSql(1_000_000, 'different-seed'));
  assert.ok(Buffer.byteLength(first) < 12_000);
  assert.match(first, /generate_series\(0,1000000-1\)/);
});

test('rejects malformed/unbounded counts and SQL-bearing seeds before emitting SQL', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, 1_000_001]) assert.throws(() => fixtureSql(count));
  for (const seed of ["a'; DROP TABLE nodes; --", 'a', 'Aaa', '../prod', 'x'.repeat(33)]) assert.throws(() => fixtureSql(10, seed));
  const run = spawnSync(process.execPath, ['scripts/e2e/scale-fixture.mjs', '1000001'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
});

test('disposable SQL preserves constraints and refuses populated fixture identities', () => {
  const sql = fixtureSql(10);
  assert.match(sql, /current_database\(\) <> 'e2e' OR current_user <> 'e2e'/);
  assert.match(sql, /standard synthetic E2E seed required/);
  assert.match(sql, /scale memory already exists/);
  assert.match(sql, /control identity collision/);
  assert.match(sql, /count mismatch/);
  assert.match(sql, /derived field mismatch/);
  assert.match(sql, /revision count mismatch/);
  assert.doesNotMatch(sql, /DROP |DELETE |DISABLE TRIGGER|TRUNCATE /);
});
