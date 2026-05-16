import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseUrnInput, formatUrn, validateUrnType,
  parseUrn, toParserCanonical, isParserCanonical,
  validateUserSlug, parseFor, UrnParseError,
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

  it('rewrites non-canonical input on the migrated path', () => {
    const result = parseFor({
      urn: 'urn:agent:micromentor.org::app:coding-app',
      urnNormalizedAt: new Date(),
    });
    expect(result.isLegacy).toBe(false);
    expect(result.canonical).toBe('urn:agent:micromentor.org::coding-app');
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
});

// =====================================================================
// Spec 021 T015 — parser performance microbenchmark
//
// Per research.md R-006, this benchmark REPORTS p95 latency and emits a
// warning if it exceeds 200µs (2× the spec target). It is NOT a hard CI
// gate — CI machine variance would make a strict threshold flaky. The
// "shouldn't take more than" guard below is intentionally generous (1ms
// per parse) so the test almost never fails — a regression to >1ms per
// parse on representative inputs is severe enough to warrant a CI
// failure even with variance.
// =====================================================================

describe('parseUrn — microbenchmark (reported metric, not a hard gate)', () => {
  it('parses 1000 representative URNs and reports p95', () => {
    // Representative input distribution: 40% install URNs, 30% role-
    // marker URNs, 30% node-path URNs. All canonical inputs (no rewrite
    // work) — the benchmark measures pure parse throughput.
    const sample = [
      ...Array(400).fill('urn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent'),
      ...Array(300).fill('urn:memory:micromentor.org::coding-app::coding-agent::app-user:shadowbrush'),
      ...Array(300).fill('urn:prompt:micromentor.org::coding-app::coding-agent::system::review:sort-imports'),
    ];

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

    // Hard guard: regression above 1ms per parse on representative
    // inputs is a real problem regardless of CI variance.
    expect(p95).toBeLessThan(1);
  });
});
