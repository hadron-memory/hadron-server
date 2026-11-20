// Only exit status and a fixed diagnostic cross this boundary; malformed samples are never echoed.
import {readFileSync} from 'node:fs';
import {SAMPLE_MS_MIN, SAMPLE_MS_MAX} from './sampler.mjs';
function validSamples(text, expectedEnd) {
  try {
    if (!text.endsWith('\n')) return false;
    const rows=text.trim().split('\n').map(line=>JSON.parse(line));
    if (rows.some(r=>!r || r.kind==='abort')) return false;
    const samples=rows.filter(r=>r.kind==='sample');
    if (!samples.length) return false;
    if (expectedEnd !== undefined && (!Number.isFinite(expectedEnd) || !samples.every(r=>Number.isFinite(r.at)) || samples.at(-1).at < expectedEnd)) return false;
    return true;
  } catch {return false;}
}
// #2624: --interval reads samples on stdin and prints the interval the preload recorded in its config record, when
// it is a supported value (sampler.mjs's 100..10000 ms integer). The runner's freshness slack is two periods of it.
function recordedInterval(text) {
  try {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r && r.kind === 'config') {
        const ms = r.sampleMs;
        return Number.isInteger(ms) && ms >= SAMPLE_MS_MIN && ms <= SAMPLE_MS_MAX ? ms : null;
      }
    }
  } catch {}
  return null;
}
if (process.argv[2] === '--interval') {
  let ms = null;
  try { ms = recordedInterval(readFileSync(0, 'utf8')); } catch {}
  if (ms === null) { console.error('diagnosis samples carry no supported sampling interval'); process.exit(5); }
  process.stdout.write(`${ms}\n`);
  process.exit(0);
}
// Pure CLI: validation must run regardless of symlinks, URL encoding or argv path spelling.
let valid=false;
try {valid=validSamples(readFileSync(process.argv[2],'utf8'),process.argv[3] ? Number(process.argv[3]) : NaN);} catch {}
if (!valid) {console.error('diagnosis samples aborted, incomplete or stale');process.exit(5);}
process.stdout.write('validated\n');
