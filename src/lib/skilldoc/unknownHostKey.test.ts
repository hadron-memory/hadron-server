/**
 * #1292 — a key under `properties.exports` that names no host
 * (cor:agt:030:06, D-2026-09-23-E): a WARNING attributed to no host, never
 * an alias, and never blocking anything.
 */
import { describe, expect, it } from 'vitest';
import { HOST_CLAUDE_SKILL, HOST_CODEX_SKILL } from './hosts.js';
import { unknownHostKeys, unknownHostKeyStats } from './declaration.js';
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
          'properties.exports.codex names no host (known: claudeSkill, codexSkill) — nothing exports it; rename it to a host key or remove it',
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

  it('unknownHostKeyStats counts unknown keys and their UTF-8 bytes, ignoring known hosts', () => {
    // Measured without sorting or building anything per key (@codex P1, #1296).
    expect(unknownHostKeyStats({ exports: { claudeSkill: ok, codex: ok, 'é': 1 } })).toEqual({ count: 2, bytes: 5 + 2 });
    expect(unknownHostKeyStats({ exports: 'yes' })).toEqual({ count: 0, bytes: 0 });
    expect(unknownHostKeyStats({})).toEqual({ count: 0, bytes: 0 });
  });
});
