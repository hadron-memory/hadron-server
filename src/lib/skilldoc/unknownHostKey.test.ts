/**
 * #1292 — a key under `properties.exports` that names no host
 * (cor:agt:030:06, D-2026-09-23-E): a WARNING attributed to no host, never
 * an alias, and never blocking anything.
 */
import { describe, expect, it } from 'vitest';
import { HOST_CLAUDE_SKILL, HOST_CODEX_SKILL } from './hosts.js';
import { unknownHostKeys, unknownHostKeysBounded } from './declaration.js';
import { lintNode, lintUnknownHostKeys, RULE_UNKNOWN_HOST_KEY, type SkillNode } from './lint.js';

const ok = { name: 'hadron-demo', description: 'Use when demoing.', enable: true };
const node = (properties: unknown): SkillNode => ({
  urn: 'hrn:node:example.com:demo:tasks:demo',
  loc: 'tasks:demo',
  memoryUrn: 'hrn:mem:example.com:demo',
  isRunnable: true,
  content: '# Demo\n\nSteps.',
  properties,
});
const rules = (n: SkillNode, host: string) => lintNode(n, host).map((f) => `${f.rule}:${f.severity}`);

describe('an unknown exports key (#1292)', () => {
  it('is one WARNING, naming the key and the known hosts', () => {
    const got = lintUnknownHostKeys(node({ exports: { codex: ok } }));
    expect(got).toEqual([
      {
        urn: 'hrn:node:example.com:demo:tasks:demo',
        memory: 'hrn:mem:example.com:demo',
        rule: RULE_UNKNOWN_HOST_KEY,
        severity: 'warning',
        message:
          'properties.exports key "codex" names no skill host (supported: claudeSkill, codexSkill) — nothing exports it, and it is not read as an alias for any host; rename it to a supported key or remove it',
      },
    ]);
  });

  it('is attributed to NO host: neither host pass reports it', () => {
    // The key belongs to none of the hosts. Emitted from every host's pass it
    // would merge into one row claiming all of them (team chat #1206).
    const n = node({ exports: { codex: ok } });
    expect(rules(n, HOST_CLAUDE_SKILL)).toEqual([]);
    expect(rules(n, HOST_CODEX_SKILL)).toEqual([]);
  });

  it('is never read as an alias: `codex` is not `codexSkill`', () => {
    const n = node({ exports: { codex: ok } });
    expect(lintNode(n, HOST_CODEX_SKILL)).toEqual([]);
    expect(unknownHostKeys(n.properties)).toEqual(['codex']);
  });

  it('does not stop the known host beside it from being judged', () => {
    const n = node({ exports: { claudeSkill: ok, codex: ok } });
    expect(rules(n, HOST_CLAUDE_SKILL)).toEqual([]);
    expect(lintUnknownHostKeys(n).map((f) => f.rule)).toEqual([RULE_UNKNOWN_HOST_KEY]);
  });

  it('never BLOCKS, even when its value is malformed', () => {
    // Before #1292 every exports.* entry was shape-checked, so `codex: "yes"`
    // was a `skill-declaration-malformed` ERROR on every host, and the valid
    // Claude declaration beside it was withheld from export. :06 lists
    // "blocking on it" as invalidating.
    const n = node({ exports: { claudeSkill: ok, codex: 'yes' } });
    expect(rules(n, HOST_CLAUDE_SKILL)).toEqual([]);
    expect(rules(n, HOST_CODEX_SKILL)).toEqual([]);
    expect(lintUnknownHostKeys(n).map((f) => `${f.rule}:${f.severity}`)).toEqual([
      `${RULE_UNKNOWN_HOST_KEY}:warning`,
    ]);
  });

  it('CONTROL: a malformed KNOWN host entry is still an error', () => {
    // The narrowing is to unknown keys only. Without this control, dropping
    // the shape check altogether would pass every case above.
    const n = node({ exports: { claudeSkill: ok, codexSkill: 'yes' } });
    expect(rules(n, HOST_CLAUDE_SKILL)).toContain('skill-declaration-malformed:error');
    expect(lintUnknownHostKeys(n)).toEqual([]);
  });

  it('CONTROL: `exports` itself not being an object is still an error, and names no key', () => {
    const n = node({ exports: 'yes' });
    expect(rules(n, HOST_CLAUDE_SKILL)).toContain('skill-declaration-malformed:error');
    expect(lintUnknownHostKeys(n)).toEqual([]);
  });

  it('reports several unknown keys in UTF-8 byte order, not UTF-16 unit order', () => {
    // The ordering the pre-#1292 `declared` fixtures pinned on malformed paths
    // now applies here: a `--strict` gate needs a deterministic report.
    // U+E000 sorts BEFORE U+10000 in UTF-8 bytes and AFTER it in UTF-16 units.
    const n = node({ exports: { '\u{10000}': ok, zebra: ok, alpha: ok, '': ok } });
    expect(unknownHostKeys(n.properties)).toEqual(['alpha', 'zebra', '', '\u{10000}']);
    expect(lintUnknownHostKeys(n)).toHaveLength(4);
  });

  it('is empty for a node with no exports, or only known hosts', () => {
    expect(lintUnknownHostKeys(node({}))).toEqual([]);
    expect(lintUnknownHostKeys(node({ exports: { claudeSkill: ok, codexSkill: ok } }))).toEqual([]);
    // Inherited members are not keys the author wrote.
    expect(lintUnknownHostKeys(node({ exports: {} }))).toEqual([]);
  });


  it('unknownHostKeysBounded EQUALS the sorted definition, for random key sets (property test)', () => {
    // Deterministic PRNG so a failure reproduces.
    let seed = 1292;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alphabet = ['a', 'b', 'z', 'é', '\u{E000}', '\u{10000}', 'claudeSkill', 'codexSkill', ' ', '"'];
    for (let run = 0; run < 300; run += 1) {
      const exports: Record<string, unknown> = {};
      const n = Math.floor(rnd() * 40);
      for (let i = 0; i < n; i += 1) {
        const len = 1 + Math.floor(rnd() * 4);
        let k = '';
        for (let j = 0; j < len; j += 1) k += alphabet[Math.floor(rnd() * alphabet.length)];
        exports[k] = true;
      }
      const limit = Math.floor(rnd() * 12);
      const maxBytes = 1 + Math.floor(rnd() * 8);
      const props = { exports };
      const expected = unknownHostKeys(props).filter((k) => Buffer.byteLength(k, 'utf8') <= maxBytes).slice(0, limit);
      expect(unknownHostKeysBounded(props, limit, maxBytes)).toEqual({ total: unknownHostKeys(props).length, keys: expected });
    }
  });
});
