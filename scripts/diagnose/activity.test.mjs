import assert from 'node:assert/strict';
import { test } from 'vitest';
import { run, w2Line } from './activity.mjs';

function fakeFetch(log, { failOn } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    log.push(body.query.match(/\)\s*\{\s*(\w+)\(/)?.[1]);
    if (failOn && body.query.includes(failOn)) return new Response(JSON.stringify({ errors: [{ message: 'boom https://x' }] }), { status: 200 });
    return new Response(JSON.stringify({ data: { ok: { id: 'x' } } }), { status: 200 });
  };
}

test('W2 sets the stall window, creates synthetic nodes and queues tasks, and counts each', async () => {
  const log = [];
  const r = await run({ base: 'http://x', key: 'k', nodes: 3, tasks: 2, fetchImpl: fakeFetch(log) });
  assert.deepEqual(r, { stallWindowSet: true, nodesCreated: 3, tasksQueued: 2 });
  assert.equal(log[0], 'setAgentTaskStallSchedule');
  assert.equal(log.filter((x) => x === 'createNode').length, 3);
  assert.equal(log.filter((x) => x === 'createAgentTask').length, 2);
});

test('a GraphQL error fails the activity and the thrown text carries no server message', async () => {
  await assert.rejects(run({ base: 'http://x', key: 'k', nodes: 1, tasks: 1, fetchImpl: fakeFetch([], { failOn: 'createNode' }) }),
    (e) => /createNode/.test(e.message) && !e.message.includes('https://x') && !e.message.includes('boom'));
});

test('the W2 output line holds counts only and marks unobserved components not exercised, never zero', () => {
  const l = w2Line({ created: { nodesCreated: 3, tasksQueued: 2 }, observed: { embedRequests: 4, embeddedNodes: 3, stallAlarms: null } });
  assert.deepEqual(l, { kind: 'w2', nodesCreated: 3, tasksQueued: 2, embedRequests: 4, embeddedNodes: 3, stallAlarms: 'not exercised' });
});
