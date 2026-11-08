import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
// A namespace import, so on code without the streaming entry point each pin fails on its own assertion rather than
// the whole file failing to load.
import * as S from './snapshot.mjs';

const { reduceSnapshot, assertReductionShape } = S;
const reduceSnapshotStream = (...a) => S.reduceSnapshotStream(...a);

// #2675: the reducer read the whole snapshot into one string, so a snapshot past V8's string limit (0x1fffffe8
// characters) could not be reduced at all. These pins hold the streaming reduction to today's output.
const V8_STRING_LIMIT = 0x1fffffe8;
const TYPES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint'];
const META = { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'], node_types: [TYPES] };

// The reduction as it was before #2675, verbatim, so byte-identity is checked against the old code and not against
// whatever the new code happens to share with itself.
function legacyReduce(snap, { top = 1000 } = {}) {
  const NAMED_TYPES = new Set(['object', 'array', 'native', 'hidden']);
  const CTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.<>() ]{0,80}$/;
  const label = (type, name) => (!NAMED_TYPES.has(type) ? `(${type})` : CTOR_NAME.test(name) ? name : '(other)');
  const fields = snap.snapshot.meta.node_fields;
  const typeNames = snap.snapshot.meta.node_types[0];
  const stride = fields.length;
  const iType = fields.indexOf('type'), iName = fields.indexOf('name'), iSize = fields.indexOf('self_size');
  const acc = new Map();
  let nodes = 0, selfSize = 0;
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = typeNames[snap.nodes[i + iType]];
    const name = label(type, snap.strings[snap.nodes[i + iName]]);
    const size = snap.nodes[i + iSize];
    const key = `${type}\u0000${name}`;
    const row = acc.get(key) ?? { type, name, count: 0, selfSize: 0 };
    row.count++; row.selfSize += size; acc.set(key, row);
    nodes++; selfSize += size;
  }
  const all = [...acc.values()].sort((a, b) => b.selfSize - a.selfSize);
  return { totals: { nodes, selfSize, rowsOmitted: Math.max(0, all.length - top) }, rows: all.slice(0, top) };
}

// A snapshot with V8's top-level key order and the sections the reducer must skip. Names may repeat by index, as V8
// deduplicates its string table.
function snapOf(entries, strings) {
  const nodes = [];
  entries.forEach(([type, nameIdx, size], id) => nodes.push(TYPES.indexOf(type), nameIdx, id, size, 0, 0, 0));
  return {
    snapshot: { meta: META, node_count: entries.length, edge_count: 2, trace_function_count: 0 },
    nodes, edges: [1, 2, 7, 3, 4, 14], trace_function_infos: [], trace_tree: [[0, 0, [1, [2, []]]]],
    samples: [], locations: [{ a: 'x]}"', b: [1, { c: null }] }], strings,
  };
}

// V8 writes one node per line; the reducer must not depend on that, so serialize both ways.
function texts(snap) {
  const v8ish = JSON.stringify(snap).replace('"nodes":[', '"nodes":[\n').replace(/(,0,0,0),/g, '$1\n,');
  return [JSON.stringify(snap), JSON.stringify(snap, null, 1), v8ish];
}

function chunked(text, size) { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; }

// Deterministic PRNG so a failing case reproduces.
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

const NAME_POOL = [
  'Map', 'Set', 'Object', 'Array', 'Buffer', 'system / Context', '(object elements)', 'hdr_user_deadbeef postgres://u:p@h/db',
  'café', 'Ünïcødé', 'quote"inside', 'back\\slash', 'tab\there', 'line\nbreak', ' sep', 'x'.repeat(81), 'y'.repeat(82),
  'z'.repeat(5000), 'Promise<Thing>', 'a.b.c', '', '😀Emoji', 'https://internal.example/path?token=abc',
];

function randomSnap(seed, n) {
  const r = rng(seed);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const type = TYPES[Math.floor(r() * TYPES.length)];
    // Some sizes repeat on purpose so the sort meets ties and must keep first-occurrence order.
    entries.push([type, Math.floor(r() * NAME_POOL.length), r() < 0.3 ? 64 : Math.floor(r() * 5000)]);
  }
  return snapOf(entries, NAME_POOL);
}

const reduceText = (text, size, opts) => reduceSnapshotStream(chunked(text, size), opts);

test('the streaming reduction is byte-identical to the old one, however the input is chunked', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const snap = randomSnap(seed, 400);
    const want = JSON.stringify(legacyReduce(snap));
    assert.equal(JSON.stringify(reduceSnapshot(snap)), want, `in-memory, seed ${seed}`);
    for (const text of texts(snap)) {
      for (const size of [1, 2, 3, 7, 64, 4096, text.length]) {
        assert.equal(JSON.stringify(await reduceText(text, size)), want, `seed ${seed}, chunk ${size}`);
      }
    }
  }
});

test('ties keep first-occurrence order and bucketed names merge in the same place as before', async () => {
  // '(other)' is reached from two different string indices, and Map/Set/(string) tie on size.
  const snap = snapOf([
    ['object', 22, 10], ['object', 0, 10], ['string', 7, 10], ['object', 1, 10], ['object', 17, 10], ['native', 4, 10],
  ], NAME_POOL);
  const want = JSON.stringify(legacyReduce(snap));
  assert.equal(JSON.stringify(await reduceText(JSON.stringify(snap), 5)), want);
  assert.equal(JSON.stringify(await reduceText(JSON.stringify(snap), 5, { top: 2 })), JSON.stringify(legacyReduce(snap, { top: 2 })));
});

// CTOR_NAME admits ASCII only, so a non-ASCII name buckets as '(other)' however its bytes decode; this pins that Buffer
// input reduces the same as text, not the decoder itself.
test('Buffer chunks that split a multi-byte character reduce the same as text', async () => {
  const snap = snapOf([['object', 8, 5], ['object', 21, 6], ['object', 9, 7]], NAME_POOL);
  const bytes = Buffer.from(JSON.stringify(snap), 'utf8');
  for (const size of [1, 2, 3, 5]) {
    const chunks = []; for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    assert.equal(JSON.stringify(await reduceSnapshotStream(chunks)), JSON.stringify(legacyReduce(snap)), `byte chunk ${size}`);
  }
});

test('a snapshot longer than V8\'s string limit reduces from a stubbed reader', async () => {
  // The bulk sits in "edges", which the reducer never needs; one shared 1 MiB chunk keeps the test's own memory small.
  const head = JSON.stringify(snapOf([['object', 0, 100], ['object', 0, 50], ['string', 1, 400]], ['Map', 'secret value']))
    .replace(/"edges":\[[^\]]*\]/, '"edges":[');
  const [before, after] = head.split('"edges":[');
  const pad = '0,'.repeat(1 << 19);
  let total = 0;
  async function* reader() {
    yield (total += before.length + 9, `${before}"edges":[`);
    for (let i = 0; i < 513; i++) { total += pad.length; yield pad; }
    const tail = `0]${after}`; total += tail.length; yield tail;
  }
  const r = await reduceSnapshotStream(reader());
  assert(total > V8_STRING_LIMIT, `fixture is ${total} characters, must pass ${V8_STRING_LIMIT}`);
  assert.deepEqual(r, {
    totals: { nodes: 3, selfSize: 550, rowsOmitted: 0 },
    rows: [{ type: 'string', name: '(string)', count: 1, selfSize: 400 }, { type: 'object', name: 'Map', count: 2, selfSize: 150 }],
  });
  assertReductionShape(r);
}, 120_000);

test('a constructor name longer than the string limit is bucketed without being held', async () => {
  // Only the string-table entries named nodes point at are kept, and only up to a bound: this one would not fit in a
  // JavaScript string, so it must be recognised as too long to publish while it is still streaming past.
  const [before, after] = JSON.stringify(snapOf([['object', 0, 10], ['object', 1, 20]], ['Map', 'PLACEHOLDER'])).split('PLACEHOLDER');
  const pad = 'N'.repeat(1 << 20);
  let total = 0;
  async function* reader() {
    total += before.length; yield before;
    for (let i = 0; i < 513; i++) { total += pad.length; yield pad; }
    total += after.length; yield after;
  }
  const r = await reduceSnapshotStream(reader());
  assert(total > V8_STRING_LIMIT);
  assert.deepEqual(r.rows, [{ type: 'object', name: '(other)', count: 1, selfSize: 20 }, { type: 'object', name: 'Map', count: 1, selfSize: 10 }]);
}, 120_000);

test('a snapshot whose nodes come before their meta is refused, not misread', async () => {
  const text = '{"nodes":[3,0,0,1,0,0,0],"snapshot":{"meta":' + JSON.stringify(META) + '},"strings":["Map"]}';
  await assert.rejects(reduceText(text, 8), /before .*meta/);
});

test('a snapshot whose strings come before its nodes is refused, not misread', async () => {
  const text = '{"snapshot":{"meta":' + JSON.stringify(META) + '},"strings":["Map"],"nodes":[3,0,0,1,0,0,0]}';
  await assert.rejects(reduceText(text, 8), /strings.*before.*nodes/);
});

test('a truncated snapshot is refused', async () => {
  const text = JSON.stringify(snapOf([['object', 0, 1]], ['Map']));
  for (const cut of [text.length - 1, text.indexOf('"strings"') + 14, text.indexOf('"nodes"') + 12]) {
    await assert.rejects(reduceText(text.slice(0, cut), 16), /snapshot/);
  }
});

test('the command line reduces a snapshot file by streaming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap2675-'));
  try {
    const snap = randomSnap(99, 300);
    const file = join(dir, 'x.heapsnapshot');
    writeFileSync(file, texts(snap)[2]);
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('./snapshot.mjs', import.meta.url)), file], { encoding: 'utf8' });
    assert.equal(out, `${JSON.stringify(legacyReduce(snap))}\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
