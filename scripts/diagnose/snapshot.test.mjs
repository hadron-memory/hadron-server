import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reduceSnapshot, diffReductions, assertReductionShape } from './snapshot.mjs';

// A minimal V8 heap snapshot: node_fields order and type names as the real format declares them.
function snap(entries) {
  const types = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint'];
  const strings = []; const nodes = [];
  for (const [type, name, size] of entries) { strings.push(name); nodes.push(types.indexOf(type), strings.length - 1, nodes.length, size, 0, 0, 0); }
  return { snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'], node_types: [types] }, node_count: entries.length }, nodes, strings };
}

test('only constructor and type names survive; string values and function names never do', () => {
  const r = reduceSnapshot(snap([
    ['object', 'Map', 100], ['object', 'Map', 50], ['string', 'hdr_user_deadbeef postgres://u:p@h/db', 400],
    ['closure', 'secretCallback', 20], ['native', 'Buffer', 300], ['array', '(object elements)', 64],
  ]));
  const text = JSON.stringify(r);
  assert(!text.includes('hdr_user') && !text.includes('postgres') && !text.includes('secretCallback'));
  const map = r.rows.find((x) => x.name === 'Map');
  assert.deepEqual(map, { type: 'object', name: 'Map', count: 2, selfSize: 150 });
  assert(r.rows.some((x) => x.type === 'string' && x.name === '(string)' && x.count === 1 && x.selfSize === 400));
  assertReductionShape(r);
});

test('a constructor name that is not a plain identifier is bucketed, not published', () => {
  const r = reduceSnapshot(snap([['object', 'https://internal.example/path?token=abc', 10]]));
  assert(!JSON.stringify(r).includes('internal.example'));
  assertReductionShape(r);
});

test('the shape check refuses anything but type, constructor name and numbers', () => {
  assert.throws(() => assertReductionShape({ totals: { nodes: 1, selfSize: 1 }, rows: [{ type: 'object', name: 'Map', count: 1, selfSize: 1, value: 'x' }] }));
  assert.throws(() => assertReductionShape({ totals: { nodes: 1, selfSize: 1 }, rows: [{ type: 'object', name: 'has spaces and /slashes?x=1', count: 1, selfSize: 1 }] }));
  assert.throws(() => assertReductionShape({ totals: { nodes: 1, selfSize: 1 }, rows: [{ type: 'object', name: 'Map', count: 'one', selfSize: 1 }] }));
});

test('a diff reports count and size deltas, largest growth first', () => {
  const a = reduceSnapshot(snap([['object', 'Map', 100], ['object', 'Set', 10]]));
  const b = reduceSnapshot(snap([['object', 'Map', 100], ['object', 'Map', 900], ['object', 'Set', 10]]));
  const d = diffReductions(a, b);
  assert.deepEqual(d[0], { type: 'object', name: 'Map', countDelta: 1, sizeDelta: 900 });
});

test('a regexp node named by its source is published under its type label', () => {
  const r = reduceSnapshot(snap([['regexp', 'Bearer abc123', 10]]));
  assert(!JSON.stringify(r).includes('Bearer'));
  assert.equal(r.rows[0].name, '(regexp)');
});

test('a diff reports releases and does not fabricate growth from rows a cut dropped', () => {
  const a = reduceSnapshot(snap([['object', 'Big', 900], ['object', 'Gone', 500], ['object', 'Small', 10]]));
  const b = reduceSnapshot(snap([['object', 'Big', 900], ['object', 'Small', 10]]));
  assert.deepEqual(diffReductions(a, b)[0], { type: 'object', name: 'Gone', countDelta: -1, sizeDelta: -500 });
  const cutA = reduceSnapshot(snap([['object', 'Big', 900], ['object', 'Small', 10]]), { top: 1 });
  const fullB = reduceSnapshot(snap([['object', 'Big', 900], ['object', 'Small', 10]]));
  assert.equal(cutA.totals.rowsOmitted, 1);
  assert(!diffReductions(cutA, fullB).some((x) => x.name === 'Small'), 'Small was cut from A, not absent');
});
