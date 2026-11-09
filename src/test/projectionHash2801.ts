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

/** The old bare hash mismatch: #2801's red pin requires node/field diagnostics instead. */
export function projectionHashDiagnostic(_text: string, _expected: ProjectionFieldHashes): string {
  return 'response hash mismatch';
}
