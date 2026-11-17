import { createHash } from 'node:crypto';

/** Test diagnostics only: the immutable whole-response hash remains the parity oracle. */
export type ProjectionFieldHashes = Record<string, Record<string, string>>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Split the deterministic dense MCP fixture into named diagnostic fields, without retaining body text. */
export function projectionFieldHashes(text: string): ProjectionFieldHashes {
  const fields: Record<string, Record<string, string[]>> = {};
  const lines = text.split('\n');
  let node = 'batch';
  let field = 'header';
  let body = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\*\*Synthetic \d+\*\*$/.test(line)) {
      node = lines[i + 1] ?? 'missing-node-urn';
      field = 'name';
      body = false;
    } else if (line === node) field = 'urn';
    else if (line === '---') { field = 'content'; body = true; }
    else if (!body && /^[A-Z][A-Za-z ]*:/.test(line)) field = line.slice(0, line.indexOf(':'));
    else if (!body && line === '') field = 'abstract';
    const group = (fields[node] ??= {});
    (group[field] ??= []).push(line);
  }
  return Object.fromEntries(Object.entries(fields).map(([node, values]) => [node,
    Object.fromEntries(Object.entries(values).map(([field, lines]) => [field, hash(lines.join('\n'))])),
  ]));
}

/** #2801: identify changed node/field hashes without dumping expected or current content. */
export function projectionHashDiagnostic(text: string, expected: ProjectionFieldHashes): string {
  const actual = projectionFieldHashes(text);
  const changed: string[] = [];
  for (const node of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const before = expected[node] ?? {};
    const after = actual[node] ?? {};
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[field] !== after[field]) changed.push(`node ${node}, field ${field}`);
    }
  }
  return changed.length ? `response hash mismatch: ${changed.join('; ')}` : 'response hash mismatch: framing changed';
}
