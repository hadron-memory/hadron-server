/**
 * #2030 (C6) acceptance pin: the TS router's attention poll is retired, so no file under scripts/ may call the
 * team attention API. The live deliverer is scripts/ticker-wake/, which imports only the router's terminal and
 * idle helpers from ./router.ts; those stay. S11 (#2027) removes the server query, and this pin is what proves
 * nothing under scripts/ still depends on it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
// Built from parts so this file does not name the query it forbids. Exact case on purpose: the cross-parent manifest
// still classifies the server's TeamAttentionPage TYPES until S11 (#2027) removes them; that is not a caller.
const QUERY = ['team', 'Attention', 'Page'].join('');
const SELF = fileURLToPath(import.meta.url);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

describe('#2030 C6: the attention poll is retired', () => {
  it('no file under scripts/ names the team attention query', () => {
    const hits: string[] = [];
    for (const p of walk(SCRIPTS)) {
      if (p === SELF || !/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|sh|py|ya?ml|toml)$/.test(p)) continue;
      if (readFileSync(p, 'utf8').includes(QUERY)) hits.push(relative(SCRIPTS, p));
    }
    expect(hits).toEqual([]);
  });

  it('the router entrypoint no longer offers the poll or loop commands', () => {
    const src = readFileSync(join(SCRIPTS, 'orca-attention-router', 'router.ts'), 'utf8');
    expect(src).not.toMatch(/export function (pollAttention|pollOnce|freshAttention|hasMentionOnlyRow)\b/);
    expect(src).not.toMatch(/export async function main\b/);
  });
});
