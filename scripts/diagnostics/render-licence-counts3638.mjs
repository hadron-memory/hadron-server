// Read-only renderer: output the complete measurement table, never a count ceiling.
import { readFileSync } from 'node:fs';
const [file] = process.argv.slice(2);
if (!file || process.argv.length !== 3) throw new Error('Usage: node render-licence-counts3638.mjs ARTIFACT.json');
const artifact = JSON.parse(readFileSync(file, 'utf8'));
if (artifact.complete !== true) throw new Error('Cannot render an incomplete diagnostic');
const { states, counts, repeats, paths } = artifact.matrix;
if (!states.length || !paths.length || !counts.length || !repeats.length) throw new Error('Empty matrix');
const index = new Map();
for (const row of artifact.observations) {
  if (row.shape === 'observer') continue;
  const key = JSON.stringify([row.shape, row.path, row.repeat]);
  if (index.has(key)) throw new Error('Duplicate observation');
  if (!Number.isInteger(row.sqlCount) || row.sqlCount < 0) throw new Error('Invalid SQL count');
  index.set(key, row.sqlCount);
}
if (index.size !== states.length * counts.length * repeats.length * paths.length) throw new Error('Wrong matrix size');
const lines = [
  `| State | Path | ${counts.map(n => `${n} Agent(s) ${repeats.join('/')}`).join(' | ')} |`,
  `|---|---|${counts.map(() => '---:|').join('')}`,
];
for (const state of states) for (const path of paths) {
  const values = counts.map(count => repeats.map(repeat => {
    const value = index.get(JSON.stringify([`${state}/${count}-agents`, path, repeat]));
    if (value === undefined) throw new Error('Missing observation');
    return value;
  }).join(' / '));
  lines.push(`| ${state} | ${path} | ${values.join(' | ')} |`);
}
process.stdout.write(`${lines.join('\n')}\n`);
