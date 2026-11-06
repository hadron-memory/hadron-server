import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopCapturedChild } from './captured-pid.mjs';

// Never use process.kill here: the pre-fix empty-file value denotes a group.
for (const raw of ['', ' \n', '0', '-1', '1', '+42', '2.5', '4e2', '0x10', '42oops', '2147483648', '9007199254740993']) {
  test(`captured PID ${JSON.stringify(raw)} never reaches the signal function`, () => {
    const calls = [];
    assert.equal(stopCapturedChild(raw, (...args) => calls.push(args)), false);
    assert.deepEqual(calls, []);
  });
}

test('a captured child PID with the shell newline signals exactly that child', () => {
  const calls = [];
  assert.equal(stopCapturedChild('4242\n', (...args) => calls.push(args)), true);
  assert.deepEqual(calls, [[4242, 'SIGTERM']]);
});
