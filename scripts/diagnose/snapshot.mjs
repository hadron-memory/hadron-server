// Heap snapshot reduction for #2598. A V8 snapshot is full of values (string contents, closure names), so only the
// reduction ever leaves the private stack: per (type, constructor name) counts and self sizes, nothing else.
const NAMED_TYPES = new Set(['object', 'array', 'native', 'hidden', 'regexp']);
const CTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.<>() ]{0,80}$/;   // identifier-ish; no slashes, colons, quotes or '='
const ROW_KEYS = ['count', 'name', 'selfSize', 'type'];

// Types whose name is a VALUE (string contents, function names) are published under a fixed label instead.
function label(type, name) {
  if (!NAMED_TYPES.has(type)) return `(${type})`;
  return CTOR_NAME.test(name) ? name : '(other)';
}

export function reduceSnapshot(snap, { top = 40 } = {}) {
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
  // Rows whose type is not a named one carry the type as the label, so they publish as { type, name: '(type)' }.
  const rows = [...acc.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, top);
  return { totals: { nodes, selfSize }, rows };
}

export function diffReductions(a, b, { top = 40 } = {}) {
  const k = (r) => `${r.type}\u0000${r.name}`;
  const before = new Map(a.rows.map((r) => [k(r), r]));
  const out = [];
  for (const r of b.rows) {
    const p = before.get(k(r));
    out.push({ type: r.type, name: r.name, countDelta: r.count - (p?.count ?? 0), sizeDelta: r.selfSize - (p?.selfSize ?? 0) });
  }
  return out.sort((x, y) => y.sizeDelta - x.sizeDelta).slice(0, top);
}

const isNum = (n) => Number.isSafeInteger(n);
// Refuses anything but constructor/type names and integers; run before every publish.
export function assertReductionShape(r) {
  if (!r?.totals || !isNum(r.totals.nodes) || !isNum(r.totals.selfSize)) throw new Error('reduction refused: bad totals');
  for (const row of r.rows) {
    if (Object.keys(row).sort().join() !== ROW_KEYS.join()) throw new Error('reduction refused: unexpected row field');
    if (typeof row.type !== 'string' || !/^[a-z ]+$/.test(row.type)) throw new Error('reduction refused: bad type');
    if (typeof row.name !== 'string' || !(CTOR_NAME.test(row.name) || /^\([a-z ]+\)$/.test(row.name))) throw new Error('reduction refused: bad name');
    if (!isNum(row.count) || !isNum(row.selfSize)) throw new Error('reduction refused: non-numeric');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  if (process.argv[2] === '--report') {
    // usage: node snapshot.mjs --report <file of {"label":..,"reduction":..} lines>  -> published lines: reductions, then start->load->idle diffs.
    const items = readFileSync(process.argv[3], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const it of items) { assertReductionShape(it.reduction); console.log(JSON.stringify({ kind: 'heapReduction', label: it.label, ...it.reduction })); }
    for (let i = 1; i < items.length; i++) console.log(JSON.stringify({ kind: 'heapDiff', from: items[i - 1].label, to: items[i].label, rows: diffReductions(items[i - 1].reduction, items[i].reduction) }));
  } else {
    // usage: node snapshot.mjs <file.heapsnapshot>  -> one JSON reduction on stdout. Runs outside the server process.
    const r = reduceSnapshot(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    assertReductionShape(r);
    console.log(JSON.stringify(r));
  }
}
