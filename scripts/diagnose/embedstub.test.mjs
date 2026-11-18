import assert from 'node:assert/strict';
import { test } from 'vitest';
import { vectorFor, embedResponse, EMBED_DIM } from './embedstub.mjs';

test('the stub answers the Ollama batch shape with one 768-d vector per input, deterministically', () => {
  const r = embedResponse({ input: ['a', 'b'] });
  assert.equal(r.embeddings.length, 2);
  assert.equal(r.embeddings[0].length, EMBED_DIM);
  assert.equal(EMBED_DIM, 768);
  assert.deepEqual(vectorFor('a'), vectorFor('a'));
  assert.notDeepEqual(vectorFor('a'), vectorFor('b'));
});
test('a malformed body is refused rather than answered with an empty batch', () => {
  assert.throws(() => embedResponse({}), /bad embed request/);
});
