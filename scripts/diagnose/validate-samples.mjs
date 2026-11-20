// Only exit status and a fixed diagnostic cross this boundary; malformed samples are never echoed.
import {readFileSync} from 'node:fs';
import {SAMPLE_MS_MIN, SAMPLE_MS_MAX, freshnessSlackMs} from './sampler.mjs';
function validSamples(text, minSampleAt) {
  try {
    if (!text.endsWith('\n')) return false;
    const rows=text.trim().split('\n').map(line=>JSON.parse(line));
    if (rows.some(r=>!r || r.kind==='abort')) return false;
    const samples=rows.filter(r=>r.kind==='sample');
    if (!samples.length) return false;
    if (minSampleAt !== undefined && (!Number.isFinite(minSampleAt) || !samples.every(r=>Number.isFinite(r.at)) || samples.at(-1).at < minSampleAt)) return false;
    return true;
  } catch {return false;}
}
// #2624: the sampling interval the preload recorded. A file must hold exactly ONE config record (#4609 BLIND F2: a
// second one, from a restarted preload, would leave it ambiguous which cadence governs) with a supported sampleMs.
function recordedInterval(text) {
  try {
    const configs = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r && r.kind === 'config');
    if (configs.length !== 1) return null;
    const ms = configs[0].sampleMs;
    return Number.isInteger(ms) && ms >= SAMPLE_MS_MIN && ms <= SAMPLE_MS_MAX ? ms : null;
  } catch { return null; }
}
// Pure CLI: validation must run regardless of symlinks, URL encoding or argv path spelling.
// Two forms: <file> <minSampleAt> (a fixed cutoff), or <file> --until <nowMs>: the cutoff is now minus two periods of
// the interval recorded in THIS file (#4609 BLIND F1: the interval and the samples come from one read, the copy that is
// published, so a file replaced between two reads can never be judged by another file's cadence).
let valid=false;
let text=null;
try {text=readFileSync(process.argv[2],'utf8');} catch {}
if (text !== null && process.argv[3] === '--until') {
  const ms = recordedInterval(text);
  if (ms === null) {console.error('diagnosis samples carry no supported sampling interval');process.exit(5);}
  const now = Number(process.argv[4]);
  valid = Number.isFinite(now) && validSamples(text, now - freshnessSlackMs(ms));
} else if (text !== null) {
  valid=validSamples(text,process.argv[3] ? Number(process.argv[3]) : NaN);
}
if (!valid) {console.error('diagnosis samples aborted, incomplete or stale');process.exit(5);}
process.stdout.write('validated\n');
