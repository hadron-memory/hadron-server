// Heap snapshot reduction for #2598. A V8 snapshot is full of values (string contents, closure names), so only the
// reduction ever leaves the private stack: per (type, constructor name) counts and self sizes, nothing else.
const NAMED_TYPES = new Set(['object', 'array', 'native', 'hidden']);
const CTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$.<>() ]{0,80}$/;   // identifier-ish; no slashes, colons, quotes or '='
const ROW_KEYS = ['count', 'name', 'selfSize', 'type'];

// Types whose name is a VALUE (string contents, function names) are published under a fixed label instead.
function label(type, name) {
  if (!NAMED_TYPES.has(type)) return `(${type})`;
  return CTOR_NAME.test(name) ? name : '(other)';
}

// One accumulator behind both entry points, so the streamed reduction (#2675) cannot drift from the in-memory one.
// Nodes are grouped by (type index, string index) as they arrive; names are resolved only at the end, which is what
// lets the stream read the string table, which V8 writes last, without holding the nodes. Groups keep first-occurrence
// order and each label's row is created by its earliest group, so rows, ties and '(other)' merges come out exactly as
// a single pass over resolved names produces them.
function accumulator(meta) {
  const fields = meta.node_fields;
  const typeNames = meta.node_types[0];
  const stride = fields.length;
  const iType = fields.indexOf('type'), iName = fields.indexOf('name'), iSize = fields.indexOf('self_size');
  const groups = new Map();
  let nodes = 0, selfSize = 0;
  const node = (t, n, size) => {
    const named = NAMED_TYPES.has(typeNames[t]);
    const key = named ? `${t}:${n}` : `${t}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { t, n: named ? n : -1, count: 0, selfSize: 0 }));
    g.count++; g.selfSize += size;
    nodes++; selfSize += size;
  };
  const cur = new Array(stride);
  let k = 0;
  return {
    stride, iType, iName, iSize, node,
    // The streamed node array, one integer at a time; a node counts once all its fields have arrived.
    push: (v) => { cur[k++] = v; if (k === stride) { k = 0; node(cur[iType], cur[iName], cur[iSize]); } },
    nameIndices: () => new Set([...groups.values()].filter((g) => g.n >= 0).map((g) => g.n)),
    finish(stringAt, { top = 1000 } = {}) {
      const acc = new Map();
      for (const g of groups.values()) {
        const type = typeNames[g.t];
        const name = label(type, g.n < 0 ? undefined : stringAt(g.n));
        const key = `${type}\u0000${name}`;
        const row = acc.get(key) ?? { type, name, count: 0, selfSize: 0 };
        row.count += g.count; row.selfSize += g.selfSize; acc.set(key, row);
      }
      // Rows whose type is not a named one carry the type as the label, so they publish as { type, name: '(type)' }.
      // The cut is generous and recorded: a diff must know whether a group missing from a side is absent or just cut.
      const all = [...acc.values()].sort((a, b) => b.selfSize - a.selfSize);
      return { totals: { nodes, selfSize, rowsOmitted: Math.max(0, all.length - top) }, rows: all.slice(0, top) };
    },
  };
}

export function reduceSnapshot(snap, opts) {
  const a = accumulator(snap.snapshot.meta);
  for (let i = 0; i < snap.nodes.length; i += a.stride) a.node(snap.nodes[i + a.iType], snap.nodes[i + a.iName], snap.nodes[i + a.iSize]);
  return a.finish((i) => snap.strings[i], opts);
}

// ---- Streaming (#2675) -----------------------------------------------------------------------------------------
// A leaking build's snapshot passes V8's string limit (0x1fffffe8 characters), so it cannot be read as one string.
// This reads it as a stream of chunks (strings or Buffers) with no dependency, since run.sh copies this file alone into
// the stub container. It parses only what the reduction needs: the "snapshot" meta, the "nodes" integers and the
// string-table entries a named node points at; everything else is skipped without being kept. It expects V8's key
// order (meta, then nodes, then strings, which V8 writes last) and refuses any other rather than guessing.

const STRUCT = /["[\]{}]/g;
const QUOTE_OR_ESC = /["\\]/g;
const SCALAR_END = /[,\]}\s]/g;
// A constructor name publishes only if it is at most 81 characters, so a longer string-table entry is never kept: it
// stands in as a name that fails CTOR_NAME, which buckets it as '(other)' exactly as its full text would. 1024 escaped
// characters always cover 81 decoded ones (an escape is at most 6).
const NAME_RAW_CAP = 1024;
const OVERLONG = '/';

const fail = (what) => new Error(`snapshot: ${what}`);

class Reader {
  constructor(chunks) {
    this.it = (chunks[Symbol.asyncIterator] ?? chunks[Symbol.iterator]).call(chunks);
    this.decoder = null;
    this.buf = ''; this.pos = 0;
    this.rec = null; this.recFrom = 0;
  }

  // True while an unread character is buffered; false at the end of the input.
  async more() {
    while (this.pos >= this.buf.length) {
      if (this.rec) { this.rec.push(this.buf.slice(this.recFrom)); this.recFrom = 0; }
      const { value, done } = await this.it.next();
      if (done) {
        const tail = this.decoder ? this.decoder.end() : '';
        this.decoder = null; this.buf = tail; this.pos = 0;
        return tail.length > 0;
      }
      if (typeof value === 'string') this.buf = value;
      else {
        this.decoder ??= new (await import('node:string_decoder')).StringDecoder('utf8');
        this.buf = this.decoder.write(value);
      }
      this.pos = 0;
    }
    return true;
  }
}

// Skips whitespace and returns the next character without consuming it.
async function peek(r) {
  for (;;) {
    if (!(await r.more())) throw fail('unexpected end of input');
    const b = r.buf; let p = r.pos;
    while (p < b.length) { const c = b.charCodeAt(p); if (c !== 32 && c !== 10 && c !== 13 && c !== 9) break; p++; }
    r.pos = p;
    if (p < b.length) return b[p];
  }
}

async function expect(r, ch) {
  if ((await peek(r)) !== ch) throw fail(`expected '${ch}'`);
  r.pos++;
}

// Reads a JSON string and returns its raw (still escaped) text, or null once it passes cap; cap < 0 skips it.
async function readString(r, cap) {
  await expect(r, '"');
  let raw = '', over = cap < 0;
  for (;;) {
    if (!(await r.more())) throw fail('unexpected end of input in a string');
    const b = r.buf;
    QUOTE_OR_ESC.lastIndex = r.pos;
    const m = QUOTE_OR_ESC.exec(b);
    const end = m ? m.index : b.length;
    if (!over) { raw += b.slice(r.pos, end); if (raw.length > cap) { over = true; raw = ''; } }
    if (!m) { r.pos = b.length; continue; }
    r.pos = end + 1;
    if (b[end] === '"') return over ? null : raw;
    // A backslash and the character it escapes, which may sit in the next chunk.
    if (!(await r.more())) throw fail('unexpected end of input in a string');
    if (!over) raw += `\\${r.buf[r.pos]}`;
    r.pos++;
  }
}

async function skipValue(r) {
  const c = await peek(r);
  if (c === '"') { await readString(r, -1); return; }
  if (c !== '[' && c !== '{') {
    for (;;) {
      if (!(await r.more())) return;
      SCALAR_END.lastIndex = r.pos;
      const m = SCALAR_END.exec(r.buf);
      if (m) { r.pos = m.index; return; }
      r.pos = r.buf.length;
    }
  }
  r.pos++;
  let depth = 1;
  for (;;) {
    if (!(await r.more())) throw fail('unexpected end of input');
    STRUCT.lastIndex = r.pos;
    const m = STRUCT.exec(r.buf);
    if (!m) { r.pos = r.buf.length; continue; }
    if (m[0] === '"') { r.pos = m.index; await readString(r, -1); continue; }
    r.pos = m.index + 1;
    if (m[0] === '[' || m[0] === '{') depth++;
    else if (--depth === 0) return;
  }
}

// The value at the cursor, kept as text: only the small "snapshot" meta is read this way.
async function captureValue(r) {
  await peek(r);
  r.rec = []; r.recFrom = r.pos;
  await skipValue(r);
  r.rec.push(r.buf.slice(r.recFrom, r.pos));
  const text = r.rec.join('');
  r.rec = null;
  return text;
}

async function readInts(r, onInt) {
  await expect(r, '[');
  let n = 0, inNum = false, neg = false;
  for (;;) {
    if (!(await r.more())) throw fail('unexpected end of input in "nodes"');
    const b = r.buf; let p = r.pos;
    for (; p < b.length; p++) {
      const c = b.charCodeAt(p);
      if (c >= 48 && c <= 57) { n = n * 10 + (c - 48); inNum = true; continue; }
      if (inNum) { onInt(neg ? -n : n); n = 0; inNum = false; neg = false; }
      if (c === 93) { r.pos = p + 1; return; }
      if (c === 45) neg = true;
      else if (c !== 44 && c !== 32 && c !== 10 && c !== 13 && c !== 9) throw fail(`unexpected '${b[p]}' in "nodes"`);
    }
    r.pos = p;
  }
}

async function readStrings(r, want, onString) {
  await expect(r, '[');
  if ((await peek(r)) === ']') { r.pos++; return; }
  for (let i = 0; ; i++) {
    const wanted = want(i);
    const raw = await readString(r, wanted ? NAME_RAW_CAP : -1);
    if (wanted) onString(i, raw === null ? OVERLONG : JSON.parse(`"${raw}"`));
    const c = await peek(r);
    r.pos++;
    if (c === ']') return;
    if (c !== ',') throw fail(`expected ',' in "strings"`);
  }
}

// Reduces a snapshot read as chunks (strings or Buffers, sync or async iterable) to the same result reduceSnapshot
// gives for the parsed whole.
export async function reduceSnapshotStream(chunks, opts) {
  const r = new Reader(chunks);
  let acc = null, nodesRead = false, names = null;
  await expect(r, '{');
  if ((await peek(r)) !== '}') {
    for (;;) {
      const key = await readString(r, 64);
      await expect(r, ':');
      if (key === 'snapshot') acc = accumulator(JSON.parse(await captureValue(r)).meta);
      else if (key === 'nodes') {
        if (!acc) throw fail('"nodes" comes before the "snapshot" meta; refusing to guess its layout');
        await readInts(r, acc.push);
        nodesRead = true;
      } else if (key === 'strings') {
        if (!nodesRead) throw fail('"strings" comes before "nodes"; cannot tell which names are needed');
        const need = acc.nameIndices();
        names = new Map();
        await readStrings(r, (i) => need.has(i), (i, s) => names.set(i, s));
      } else await skipValue(r);
      const c = await peek(r);
      r.pos++;
      if (c === '}') break;
      if (c !== ',') throw fail(`expected ',' between top-level keys`);
    }
  }
  if (!names) throw fail('no "snapshot", "nodes" and "strings" sections');
  return acc.finish((i) => names.get(i), opts);
}

// Groups are compared over the union of both sides, so growth and releases both show. A group missing from a side whose
// rows were cut (rowsOmitted > 0) is unknown, not zero, and is skipped rather than reported as growth or release.
export function diffReductions(a, b, { top = 40 } = {}) {
  const k = (r) => `${r.type}\u0000${r.name}`;
  const am = new Map(a.rows.map((r) => [k(r), r])), bm = new Map(b.rows.map((r) => [k(r), r]));
  const out = [];
  for (const key of new Set([...am.keys(), ...bm.keys()])) {
    const p = am.get(key), n = bm.get(key);
    if ((!p && a.totals.rowsOmitted > 0) || (!n && b.totals.rowsOmitted > 0)) continue;
    const r = n ?? p;
    out.push({ type: r.type, name: r.name, countDelta: (n?.count ?? 0) - (p?.count ?? 0), sizeDelta: (n?.selfSize ?? 0) - (p?.selfSize ?? 0) });
  }
  return out.sort((x, y) => Math.abs(y.sizeDelta) - Math.abs(x.sizeDelta)).slice(0, top);
}

const isNum = (n) => Number.isSafeInteger(n);
// Refuses anything but constructor/type names and integers; run before every publish.
export function assertReductionShape(r) {
  if (!r?.totals || !isNum(r.totals.nodes) || !isNum(r.totals.selfSize) || !isNum(r.totals.rowsOmitted)) throw new Error('reduction refused: bad totals');
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
    // Streamed (#2675): a leaking build's snapshot is longer than any string V8 can hold.
    const { createReadStream } = await import('node:fs');
    const r = await reduceSnapshotStream(createReadStream(process.argv[2], { encoding: 'utf8', highWaterMark: 1 << 20 }));
    assertReductionShape(r);
    console.log(JSON.stringify(r));
  }
}
