/**
 * #934 sweep — every `appId && sessionId` AUTHORITY branch must gate on the
 * PURE App-key shape (`!userId`).
 *
 * User principals can carry a session binding since #934 (the heartbeat
 * attribution, cor:aut:020:02 v0.0.2). Before that, `appId && sessionId`
 * implied "App-key credential operating inside its session", and three
 * consumers had encoded that implication: the getAccessibleMemoryIds session
 * branch, its MCP node-search twin, and createChat's session-memory target.
 * A hybrid user+selection principal entering any of them gets App-session
 * semantics judged without the USER's rights — the exact misclassification
 * the PR #983 review caught in createChat after the first two were fixed.
 *
 * This sweep pins the CLASS, not the instances (the impersonationSweep
 * pattern): any new `appId && sessionId` conditional in resolver/MCP source
 * must either include the `!userId` guard on the same line or carry a
 * `// session-binding-sweep-ok:` annotation explaining why the branch is
 * attribution-only (safe for hybrid principals).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [here, join(here, '..', '..', '..', 'mcp')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
}

const PAIR = /(ctx|auth)\.appId\s*&&\s*\1\.sessionId/;

describe('#934 — session-binding authority sweep', () => {
  it('every appId && sessionId conditional guards on the pure App-key shape', () => {
    const violations: string[] = [];
    for (const dir of ROOTS) {
      for (const file of sourceFiles(dir)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const m = PAIR.exec(line);
          if (!m) return;
          const principal = m[1];
          if (line.includes(`!${principal}.userId`)) return;
          if (line.includes('session-binding-sweep-ok:')) return;
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
