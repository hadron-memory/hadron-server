// Runner-side output lines for #2598 (counts only). usage:
//   report.mjs w2 <created.json> <stub-count-json> <embedded> <stallAlarms>  -> the w2 line
//   report.mjs coverage <w2-line-or-null> <heap-json-or-null>                -> the coverage line
//   report.mjs per-session <samples.jsonl> <load-line.json>                  -> the #4448 per-session line
import { readFileSync } from 'node:fs';
import { w2Line } from './activity.mjs';
import { coverageLine, assertSecretFree } from './sampler.mjs';
import { perSessionLine } from './persession.mjs';

const [mode, ...a] = process.argv.slice(2);
const num = (x) => (/^\d+$/.test(String(x).trim()) ? Number(x) : null);
let out;
if (mode === 'w2') {
  const created = JSON.parse(readFileSync(a[0], 'utf8'));
  let stub = null; try { stub = JSON.parse(a[1]); } catch { /* stub unreachable: not exercised */ }
  out = w2Line({ created, observed: { embedRequests: stub?.requests ?? null, embeddedNodes: num(a[2]), stallAlarms: num(a[3]) } });
} else if (mode === 'coverage') {
  const j = (x) => (x && x !== 'null' ? JSON.parse(x) : null);
  out = coverageLine({ w2: j(a[0]), heap: j(a[1]) });
} else if (mode === 'per-session') {
  // Only the sample lines carry the memory series; everything else in the file is ignored.
  const samples = readFileSync(a[0], 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l && l.kind === 'sample');
  const load = JSON.parse(readFileSync(a[1], 'utf8'));
  out = perSessionLine({ samples, load });
} else { console.error('usage: report.mjs w2|coverage|per-session'); process.exit(2); }
const text = JSON.stringify(out); assertSecretFree(text); console.log(text);
