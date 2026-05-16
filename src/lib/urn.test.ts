import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseUrnInput, formatUrn, validateUrnType,
  parseUrn, toParserCanonical, isParserCanonical,
  validateUserSlug, parseFor, UrnParseError,
  composeInstalledAgentUrn,
  type AliasCategory,
} from './urn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('parseUrnInput', () => {
  it('parses urn:memory: prefix', () => {
    expect(parseUrnInput('urn:memory:hadronmemory.com:core')).toEqual({
      type: 'memory', value: 'hadronmemory.com:core',
    });
  });

  it('parses urn:node: prefix', () => {
    expect(parseUrnInput('urn:node:micromentor.org:mmdata:services:admin')).toEqual({
      type: 'node', value: 'micromentor.org:mmdata:services:admin',
    });
  });

  it('parses urn:org: prefix', () => {
    expect(parseUrnInput('urn:org:hadronmemory.com')).toEqual({
      type: 'org', value: 'hadronmemory.com',
    });
  });

  it('parses urn:agent: prefix', () => {
    expect(parseUrnInput('urn:agent:hadronmemory.com:engineering')).toEqual({
      type: 'agent', value: 'hadronmemory.com:engineering',
    });
  });

  it('parses urn:app: prefix', () => {
    expect(parseUrnInput('urn:app:hadronmemory.com:dev-ws')).toEqual({
      type: 'app', value: 'hadronmemory.com:dev-ws',
    });
  });

  it('parses loc: prefix', () => {
    expect(parseUrnInput('loc:services:admin')).toEqual({
      type: 'loc', value: 'services:admin',
    });
  });

  it('returns unknown for bare URN (backwards compat)', () => {
    expect(parseUrnInput('hadronmemory.com:core')).toEqual({
      type: 'unknown', value: 'hadronmemory.com:core',
    });
  });

  it('returns unknown for bare loc', () => {
    expect(parseUrnInput('services:admin')).toEqual({
      type: 'unknown', value: 'services:admin',
    });
  });

  it('returns unknown for empty string', () => {
    expect(parseUrnInput('')).toEqual({
      type: 'unknown', value: '',
    });
  });

  it('returns unknown for string without colons', () => {
    expect(parseUrnInput('architecture')).toEqual({
      type: 'unknown', value: 'architecture',
    });
  });
});

describe('formatUrn', () => {
  it('formats a memory URN', () => {
    expect(formatUrn('memory', 'hadronmemory.com:core')).toBe('urn:memory:hadronmemory.com:core');
  });

  it('formats a node URN', () => {
    expect(formatUrn('node', 'micromentor.org:mmdata:services:admin')).toBe('urn:node:micromentor.org:mmdata:services:admin');
  });
});

describe('validateUrnType', () => {
  it('accepts matching type', () => {
    expect(validateUrnType({ type: 'memory', value: 'x' }, 'memory')).toBeNull();
  });

  it('accepts unknown type (backwards compat)', () => {
    expect(validateUrnType({ type: 'unknown', value: 'x' }, 'memory')).toBeNull();
  });

  it('accepts loc where node is expected', () => {
    expect(validateUrnType({ type: 'loc', value: 'x' }, 'node')).toBeNull();
  });

  it('rejects mismatched type', () => {
    const result = validateUrnType({ type: 'agent', value: 'x' }, 'memory');
    expect(result).toContain('Expected memory URN');
    expect(result).toContain('got urn:agent');
  });

  it('rejects loc where memory is expected', () => {
    const result = validateUrnType({ type: 'loc', value: 'x' }, 'memory');
    expect(result).not.toBeNull();
  });
});

// =====================================================================
// Spec 021 — canonical-form parser
// =====================================================================

interface GoldenCase {
  _section?: string;
  _note?: string;
  input: string;
  expectedType?: string;
  expectedParserCanonical?: string;
  expectedParserRewrites?: AliasCategory[];
  expectedNeedsResolver?: boolean;
  expectedReject?: string;
  offendingSegment?: string;
}

const goldenSet: { cases: GoldenCase[] } = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/parser-golden-set.json'), 'utf-8'),
);

/** Test cases only — section-header records (with `_section`) excluded. */
const goldenCases: GoldenCase[] = goldenSet.cases.filter(c => c.input !== undefined);

describe('parseUrn — golden-set parity', () => {
  for (const c of goldenCases) {
    const label = c.expectedReject
      ? `[reject:${c.expectedReject}] ${c.input}`
      : `${c.input} → ${c.expectedParserCanonical}`;
    it(label, () => {
      if (c.expectedReject) {
        try {
          parseUrn(c.input);
          throw new Error(`Expected UrnParseError(${c.expectedReject}) but parsing succeeded`);
        } catch (e) {
          expect(e).toBeInstanceOf(UrnParseError);
          expect((e as UrnParseError).reason).toBe(c.expectedReject);
          if (c.offendingSegment) {
            expect((e as UrnParseError).offendingSegment).toBe(c.offendingSegment);
          }
          // Spec 021 round-1 fix (PR #124 review C2): error.input MUST
          // be the full URN, not the offending atom.
          expect((e as UrnParseError).input).toBe(c.input);
        }
        return;
      }
      const result = parseUrn(c.input);
      expect(result.type).toBe(c.expectedType);
      expect(result.parserCanonical).toBe(c.expectedParserCanonical);
      // Rewrites: compare as sorted arrays (order within parserRewrites
      // is implementation-defined; the contract is that each fired
      // category appears once).
      const got = [...result.parserRewrites].sort();
      const exp = [...(c.expectedParserRewrites ?? [])].sort();
      expect(got).toEqual(exp);
      // needsResolverCanonicalization defaults to false when omitted.
      expect(result.needsResolverCanonicalization).toBe(c.expectedNeedsResolver === true);
      // Idempotence: re-parsing the parserCanonical yields the same canonical
      // form with no further parser-layer rewrites.
      const reparsed = parseUrn(result.parserCanonical);
      expect(reparsed.parserCanonical).toBe(result.parserCanonical);
      expect(reparsed.parserRewrites).toEqual([]);
    });
  }
});

describe('parseUrn — error.input always carries the full URN', () => {
  it('threading: charset error from a buried atom carries the full URN', () => {
    // Regression for PR #124 review C2.
    try {
      parseUrn('urn:memory:org::bad seg::system');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UrnParseError);
      const err = e as UrnParseError;
      expect(err.input).toBe('urn:memory:org::bad seg::system');
      expect(err.offendingSegment).toBe('bad seg');
      expect(err.reason).toBe('invalid-charset');
    }
  });

  it('threading: empty-segment error carries the full URN', () => {
    try {
      parseUrn('urn:memory:org::::system');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.input).toBe('urn:memory:org::::system');
    }
  });

  it('threading: empty atom inside a segment carries the full URN', () => {
    try {
      parseUrn('urn:memory:org::a::b:');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.input).toBe('urn:memory:org::a::b:');
      // Empty atom is structurally invalid (FR-020), not a charset issue
      // (PR #124 review C13).
      expect(err.reason).toBe('invalid-segment-shape');
    }
  });
});

describe('parseUrn — case sensitivity (D9)', () => {
  it('treats slugs differing only in case as different URNs', () => {
    const a = parseUrn('urn:agent:acme.com::Coding-Agent');
    const b = parseUrn('urn:agent:acme.com::coding-agent');
    expect(a.parserCanonical).not.toBe(b.parserCanonical);
  });

  it('preserves slug case in parserCanonical', () => {
    const result = parseUrn('urn:agent:Hadronmemory.com::Coding-Agent');
    expect(result.parserCanonical).toBe('urn:agent:Hadronmemory.com::Coding-Agent');
  });
});

describe('toParserCanonical / isParserCanonical', () => {
  it('toParserCanonical returns the canonical form for a non-canonical input', () => {
    const canonical = toParserCanonical(
      'urn:agent:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent',
    );
    expect(canonical).toBe(
      'urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent',
    );
  });

  it('toParserCanonical is idempotent', () => {
    const once = toParserCanonical('urn:agent:micromentor.org::app:coding-app');
    const twice = toParserCanonical(once);
    expect(twice).toBe(once);
  });

  it('isParserCanonical returns true for already-canonical inputs', () => {
    expect(isParserCanonical('urn:agent:hadronmemory.com::coding-agent')).toBe(true);
  });

  it('isParserCanonical returns false for inputs needing parser-layer rewrites', () => {
    expect(
      isParserCanonical(
        'urn:agent:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent',
      ),
    ).toBe(false);
  });

  it('isParserCanonical returns false for inputs that fail to parse', () => {
    expect(isParserCanonical('not-a-urn')).toBe(false);
    expect(isParserCanonical('urn:loc:foo')).toBe(false);
  });
});

describe('validateUserSlug', () => {
  it('accepts a simple slug', () => {
    expect(() => validateUserSlug('coding-agent')).not.toThrow();
  });

  it('accepts a domain-name-style slug', () => {
    expect(() => validateUserSlug('a.b.c.com')).not.toThrow();
  });

  it('accepts a single-character slug', () => {
    expect(() => validateUserSlug('a')).not.toThrow();
  });

  it('accepts a 64-character slug', () => {
    const sixtyFour = 'a' + 'b'.repeat(62) + 'c';
    expect(sixtyFour.length).toBe(64);
    expect(() => validateUserSlug(sixtyFour)).not.toThrow();
  });

  it('rejects a 65-character slug as too-long', () => {
    try {
      validateUserSlug('x'.repeat(65));
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.reason).toBe('slug-too-long');
    }
  });

  it('rejects whitespace in slug as invalid-charset', () => {
    try {
      validateUserSlug('foo bar');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.reason).toBe('invalid-charset');
    }
  });

  it('rejects forward-slash in slug as invalid-charset', () => {
    expect(() => validateUserSlug('foo/bar')).toThrow(UrnParseError);
  });

  it('rejects leading or trailing punctuation', () => {
    expect(() => validateUserSlug('.foo')).toThrow(UrnParseError);
    expect(() => validateUserSlug('foo.')).toThrow(UrnParseError);
    expect(() => validateUserSlug('-foo')).toThrow(UrnParseError);
    expect(() => validateUserSlug('foo-')).toThrow(UrnParseError);
  });

  // FR-019: case-insensitive reserved-word check.
  it('rejects "system" as reserved-word', () => {
    try {
      validateUserSlug('system');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.reason).toBe('reserved-word-slug');
    }
  });

  it('rejects "Agent" (mixed case) as reserved-word', () => {
    try {
      validateUserSlug('Agent');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as UrnParseError;
      expect(err.reason).toBe('reserved-word-slug');
    }
  });

  it('rejects every D1 type-registry word as reserved', () => {
    const reservedSamples = [
      'agent', 'app', 'app-user', 'memory', 'node', 'org', 'user',
      'abstract', 'prompt', 'review', 'task',
      'chat', 'config', 'event', 'goal',
      'loc', // deprecated URN type, still reserved as a slug
    ];
    for (const word of reservedSamples) {
      expect(() => validateUserSlug(word)).toThrow(UrnParseError);
    }
  });

  it('rejects every D4 role-marker prefix as reserved', () => {
    const roleMarkers = ['system', 'app-mem', 'app-user', 'group-mem', 'priv'];
    for (const word of roleMarkers) {
      expect(() => validateUserSlug(word)).toThrow(UrnParseError);
    }
  });
});

describe('parseFor — per-row gate dispatch (FR-032)', () => {
  it('dispatches to the new parser for migrated rows (urnNormalizedAt set)', () => {
    const result = parseFor({
      urn: 'urn:agent:hadronmemory.com::coding-agent',
      urnNormalizedAt: new Date(),
    });
    expect(result.isLegacy).toBe(false);
    expect(result.canonical).toBe('urn:agent:hadronmemory.com::coding-agent');
  });

  it('does NOT rewrite on the migrated path — migrated rows MUST already be canonical', () => {
    // Codex / Copilot round-2 fix: parseFor used to silently rewrite a
    // migrated row that drifted from canonical. That masked bugs at
    // every downstream consumer. The new behavior throws on drift.
    expect(() =>
      parseFor({
        urn: 'urn:agent:micromentor.org::app:coding-app',
        urnNormalizedAt: new Date(),
      }),
    ).toThrow(UrnParseError);
  });

  it('returns the legacy URN unchanged for pre-migration rows (urnNormalizedAt null)', () => {
    const result = parseFor({
      urn: 'urn:agent:hadronmemory.com:coding-agent', // pre-021 single-:
      urnNormalizedAt: null,
    });
    expect(result.isLegacy).toBe(true);
    expect(result.canonical).toBe('urn:agent:hadronmemory.com:coding-agent');
  });

  it('throws when a migrated row\'s URN fails canonical parsing', () => {
    expect(() =>
      parseFor({
        urn: 'urn:fake-type:something',
        urnNormalizedAt: new Date(),
      }),
    ).toThrow(UrnParseError);
  });

  // PR #124 round-2 review: Codex #2 — parseFor's legacy branch was
  // accepting garbage because parseUrnInput never throws.
  it('rejects malformed URNs on the legacy branch (not just the migrated branch)', () => {
    expect(() =>
      parseFor({
        urn: 'not-a-urn-at-all',
        urnNormalizedAt: null,
      }),
    ).toThrow(UrnParseError);
  });

  it('accepts well-formed legacy URNs on the legacy branch', () => {
    // Pre-021 single-:-grammar URN — must still pass.
    const result = parseFor({
      urn: 'urn:agent:hadronmemory.com:coding-agent',
      urnNormalizedAt: null,
    });
    expect(result.isLegacy).toBe(true);
    expect(result.canonical).toBe('urn:agent:hadronmemory.com:coding-agent');
  });

  // PR #124 round-2 review: Copilot — parseFor previously returned
  // parserCanonical for migrated rows even when row.urn drifted. Now
  // asserts equality and throws on drift.
  it('throws when a migrated row\'s stored URN drifts from canonical', () => {
    // A migrated row that somehow has a non-canonical urn (e.g., a
    // bug bypassed the canonicalizer on write) MUST surface here,
    // not be silently rewritten.
    expect(() =>
      parseFor({
        urn: 'urn:agent:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent',
        urnNormalizedAt: new Date(),
      }),
    ).toThrow(UrnParseError);
  });
});

// PR #124 round-2 review: Codex #3 — stripTypeMarkers must not touch
// node-leaf segments because node locs are free-form intra-memory paths
// that may legitimately begin with `app:`, `agent:`, or `memory:`.
// hadron-client PR #9 Copilot review: stripTypeMarkers used to strip
// at every segment INCLUDING index 0 (the org slot). A malformed URN
// like `urn:agent:app:micromentor.org::coding-agent` would have its
// `app:` stripped from segments[0] before validation, silently
// canonicalizing to `urn:agent:micromentor.org::coding-agent`. The fix
// skips index 0; the first-segment-must-be-one-atom validator now
// catches this. Same bug existed in this parser (the code was ported
// across hadron-server / hadron-portal / hadron-client); this regression
// test locks the fix here.
describe('parseUrn — type-markers are NOT stripped from the org segment (index 0)', () => {
  it('rejects urn:agent:app:org::slug as invalid-segment-shape (not silently canonicalized)', () => {
    try {
      parseUrn('urn:agent:app:micromentor.org::coding-agent');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UrnParseError);
      expect((e as UrnParseError).reason).toBe('invalid-segment-shape');
      expect((e as UrnParseError).offendingSegment).toBe('app:micromentor.org');
    }
  });

  it('rejects urn:memory:memory:org::slug similarly (memory: prefix at org slot)', () => {
    expect(() => parseUrn('urn:memory:memory:micromentor.org::coding-agent::system')).toThrow(
      UrnParseError,
    );
  });

  it('rejects urn:agent:agent:org::slug similarly (agent: prefix at org slot)', () => {
    expect(() => parseUrn('urn:agent:agent:micromentor.org::coding-agent')).toThrow(
      UrnParseError,
    );
  });
});

// =====================================================================
// Spec 021 US1 — install URN provenance (composeInstalledAgentUrn)
//
// The helper produces the R2 canonical install URN per FR-008 / FR-009:
//   urn:agent:<installing-org>::<app-slug>::<author-org>:<agent-slug>
//
// Two orgs installing same-slug agents from different authors produce
// distinct URNs that differ at the author-org segment. Install-by-self
// (installing org equals author org) collapses via D11 cat 1.
// =====================================================================

describe('composeInstalledAgentUrn — US1 install URN provenance', () => {
  it('composes the canonical R2 install URN with `urn:` prefixes on both inputs', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('two different authors with same agent slug → distinct install URNs', () => {
    const a = composeInstalledAgentUrn(
      'urn:app:micromentor.org::coding-app',
      'urn:agent:hadronmemory.com::coding-agent',
    );
    const b = composeInstalledAgentUrn(
      'urn:app:micromentor.org::coding-app',
      'urn:agent:competitor.com::coding-agent',
    );
    expect(a).not.toBe(b);
    expect(a).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
    expect(b).toBe('urn:agent:micromentor.org::coding-app::competitor.com:coding-agent');
  });

  it('install-by-self (installing org == author org) collapses via D11 cat 1', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:hadronmemory.com::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('urn:agent:hadronmemory.com::coding-app::coding-agent');
  });

  it('accepts legacy single-`:` shapes (transitional during migration)', () => {
    // Pre-021 stored urns: `<org>:<slug>` without `urn:app:`/`urn:agent:` prefix.
    expect(
      composeInstalledAgentUrn(
        'micromentor.org:coding-app',
        'hadronmemory.com:coding-agent',
      ),
    ).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('accepts mixed grammar (legacy app, spec-021 agent)', () => {
    expect(
      composeInstalledAgentUrn(
        'micromentor.org:coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('accepts mixed grammar (spec-021 app, legacy agent)', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'hadronmemory.com:coding-agent',
      ),
    ).toBe('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('throws on an empty appUrn', () => {
    expect(() =>
      composeInstalledAgentUrn('', 'urn:agent:hadronmemory.com::coding-agent'),
    ).toThrow();
  });

  it('throws on an empty agentUrn', () => {
    expect(() =>
      composeInstalledAgentUrn('urn:app:micromentor.org::coding-app', ''),
    ).toThrow();
  });

  it('throws on a wrong-type prefix on appUrn (security: no silent coercion)', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:agent:micromentor.org::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toThrow(/urn:app/);
  });

  it('throws on a wrong-type prefix on agentUrn', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:memory:hadronmemory.com::coding-agent',
      ),
    ).toThrow(/urn:agent/);
  });

  it('throws when appUrn has only an org segment (no app slug)', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toThrow(/<org>::<slug>/);
  });

  it('throws when agentUrn has only an org segment (no agent slug)', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:agent:hadronmemory.com',
      ),
    ).toThrow(/<author-org>::<slug>/);
  });

  it('output passes parseUrn (spec-021-parseable)', () => {
    const result = composeInstalledAgentUrn(
      'urn:app:micromentor.org::coding-app',
      'urn:agent:hadronmemory.com::coding-agent',
    );
    const parsed = parseUrn(result);
    expect(parsed.type).toBe('agent');
    expect(parsed.parserCanonical).toBe(result);
    expect(parsed.parserRewrites).toEqual([]);
  });

  it('is idempotent under parser canonicalization', () => {
    const once = composeInstalledAgentUrn(
      'urn:app:micromentor.org::coding-app',
      'urn:agent:hadronmemory.com::coding-agent',
    );
    expect(toParserCanonical(once)).toBe(once);
  });
});

describe('parseUrn — node-leaf locs are NOT mangled by cat 4 strip', () => {
  it('preserves a node leaf that begins with a type-marker word', () => {
    const result = parseUrn(
      'urn:node:micromentor.org::coding-app::coding-agent::system::app:settings',
    );
    expect(result.parserCanonical).toBe(
      'urn:node:micromentor.org::coding-app::coding-agent::system::app:settings',
    );
    expect(result.parserRewrites).toEqual([]);
  });

  it('preserves a node leaf with a multi-atom path beginning with agent:', () => {
    const result = parseUrn(
      'urn:node:micromentor.org::coding-app::coding-agent::system::agent:profile:bio',
    );
    expect(result.parserCanonical).toBe(
      'urn:node:micromentor.org::coding-app::coding-agent::system::agent:profile:bio',
    );
    expect(result.parserRewrites).toEqual([]);
  });

  it('still strips type markers from intermediate node-URN segments', () => {
    // The leaf is exempt; intermediate segments still get cat 4 strip.
    const result = parseUrn(
      'urn:node:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent::system::review:sort-imports',
    );
    expect(result.parserCanonical).toBe(
      'urn:node:micromentor.org::coding-app::hadronmemory.com:coding-agent::system::review:sort-imports',
    );
    expect(result.parserRewrites).toContain('type-marker-optionality');
  });
});

// =====================================================================
// Spec 021 T015 — parser performance microbenchmark
//
// Per research.md R-006, this benchmark REPORTS p95 latency and is NOT
// a hard CI gate. PR #124 round-2 review (Copilot) flagged that timing-
// based tests in the regular vitest suite are inherently flaky on CI:
// cold-V8 warm-up costs can push the first 50-100 iterations 10-100×
// slower than steady state, and noisy-neighbor variance can spike
// individual calls.
//
// Mitigations: (a) run a warm-up pass before measuring, (b) very
// generous hard ceiling (10ms per parse — only severe regressions
// trip), (c) the failure-mode behavior is to emit a console.warn for
// 200µs+ regressions rather than throw, so the signal is visible
// without flaking the suite.
//
// The dedicated bench script for steady-state numbers lives at
// `scripts/bench/urn-parser.bench.ts` (TODO: add as part of T067-T069
// migration-ops work, where parser throughput matters most).
// =====================================================================

describe('parseUrn — microbenchmark (reported metric, not a hard gate)', () => {
  it('parses 1000 representative URNs and reports p95', () => {
    const sample = [
      ...Array(400).fill('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent'),
      ...Array(300).fill('urn:memory:micromentor.org::coding-app::coding-agent::app-user:shadowbrush'),
      ...Array(300).fill('urn:prompt:micromentor.org::coding-app::coding-agent::system::review:sort-imports'),
    ];

    // Warm-up: hit the JIT with 200 parses before measuring. Cold-V8
    // first-call overhead would otherwise skew the early samples and
    // pollute the percentile sort.
    for (let i = 0; i < 200; i++) parseUrn(sample[i % sample.length]);

    const durations: number[] = [];
    for (const input of sample) {
      const start = performance.now();
      parseUrn(input);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];

    // eslint-disable-next-line no-console
    console.log(
      `parseUrn perf: n=${sample.length} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );

    if (p95 > 0.2 /* 200µs = 2× target */) {
      // eslint-disable-next-line no-console
      console.warn(
        `parseUrn p95 ${p95.toFixed(3)}ms exceeds 200µs alert threshold (target: 100µs). Investigate.`,
      );
    }

    // Very generous hard ceiling: 10ms per parse. Only catastrophic
    // regressions (e.g., accidentally calling a DB) would trip this.
    // The real performance signal is the console.log output above.
    expect(p95).toBeLessThan(10);
  });
});
