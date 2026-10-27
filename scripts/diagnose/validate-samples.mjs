// Only exit status and a fixed diagnostic cross this boundary; malformed samples are never echoed.
import {readFileSync} from 'node:fs';
export function validSamples(text, expectedEnd) {
  try {
    const rows=text.trim().split('\n').map(line=>JSON.parse(line));
    if (rows.some(r=>!r || r.kind==='abort')) return false;
    const samples=rows.filter(r=>r.kind==='sample');
    if (!samples.length) return false;
    if (expectedEnd !== undefined && (!Number.isFinite(expectedEnd) || !samples.every(r=>Number.isFinite(r.at)) || samples.at(-1).at < expectedEnd)) return false;
    return true;
  } catch {return false;}
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let valid=false;
  try {valid=validSamples(readFileSync(process.argv[2],'utf8'),process.argv[3] ? Number(process.argv[3]) : undefined);} catch {}
  if (!valid) {console.error('diagnosis samples aborted, incomplete or stale');process.exit(5);}
}
