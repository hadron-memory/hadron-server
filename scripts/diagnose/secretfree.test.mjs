import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { assertSecretFree } from './sampler.mjs';
// Point DIAG_OUT_FILE at a produced samples file to grep real output; otherwise this checks the guard itself.
test('produced output is secret-free', () => {
  const f = process.env.DIAG_OUT_FILE;
  if (f && existsSync(f)) assertSecretFree(readFileSync(f, 'utf8'));
  assert.throws(() => assertSecretFree('"key":"hdr_user_deadbeef"'));
});
