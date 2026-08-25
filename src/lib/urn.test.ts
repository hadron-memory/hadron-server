import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseUrnInput, formatUrn, formatCanonicalUrn, validateUrnType,
  parseUrn, toParserCanonical, isParserCanonical,
  validateUserSlug, validateOrgSlug, deriveSlugFromName, parseFor, UrnParseError,
  composeInstalledAgentUrn,
  assertFullyQualifiedUrn, UrnNotQualifiedError,
  splitNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
  agentSlugFromUrn,
  MEMORY_ROLE_MARKERS,
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

  it('parses hrn:user: / urn:user: prefix (spec cor:urn:010:01)', () => {
    expect(parseUrnInput('hrn:user:holger')).toEqual({ type: 'user', value: 'holger' });
    expect(parseUrnInput('urn:user:holger')).toEqual({ type: 'user', value: 'holger' });
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
    expect(formatUrn('memory', 'hadronmemory.com:core')).toBe('hrn:memory:hadronmemory.com:core');
  });

  it('formats a node URN', () => {
    expect(formatUrn('node', 'micromentor.org:mmdata:services:admin')).toBe('hrn:node:micromentor.org:mmdata:services:admin');
  });
});

// Spec 027: canonical-form URN output wrapper. Replaces formatUrn at MCP
// emission sites. Contract: spec-kits/specs/027-mcp-urn-canonical-form/
// contracts/canonical-urn-output.md §1.
describe('formatCanonicalUrn', () => {
  describe('memory URNs', () => {
    it('rewrites legacy single-colon bare form to canonical', () => {
      expect(formatCanonicalUrn('memory', 'acme.com:dev')).toBe('hrn:memory:acme.com::dev');
    });

    it('passes canonical bare form through unchanged', () => {
      expect(formatCanonicalUrn('memory', 'acme.com::dev')).toBe('hrn:memory:acme.com::dev');
    });
  });

  describe('app URNs', () => {
    it('rewrites legacy single-colon bare form to canonical', () => {
      expect(formatCanonicalUrn('app', 'acme-corp:notes')).toBe('hrn:app:acme-corp::notes');
    });

    it('passes canonical bare form through unchanged', () => {
      expect(formatCanonicalUrn('app', 'acme-corp::notes')).toBe('hrn:app:acme-corp::notes');
    });
  });

  describe('node URNs', () => {
    it('legacy 4-segment bare splits to 4 hierarchy levels (parser semantics)', () => {
      // IMPORTANT: spec-021's parser has no way to know that
      // `services:sort-imports` was originally a single multi-atom loc
      // (pre-021 semantics). When given a legacy bare value with all
      // single-colon separators, the parser interprets EVERY colon as a
      // hierarchy separator. Callers that need the semantic "loc is the
      // leaf" interpretation (e.g. nodeUrn in src/mcp/server.ts) MUST
      // compose with explicit `::` between memory and loc — see the
      // nodeUrn implementation for the pattern.
      //
      // Slug choice note: avoiding `review` here — it lives in the D1
      // NODE_TYPES registry (a reserved word per FR-019), which the parser
      // rejects as a slug at a hierarchy-position. `services` is a plain
      // slug and exercises the same 4-level split semantics. (The
      // adjacent test below — "multi-atom leaf preserves the leaf intact"
      // — still uses `review:sort-imports` because there `review` sits
      // inside a single path-segment as an atom, where reserved-word
      // rejection doesn't apply.)
      expect(formatCanonicalUrn('node', 'acme.com:dev:services:sort-imports')).toBe(
        'hrn:node:acme.com::dev::services::sort-imports',
      );
    });

    it('canonical bare with multi-atom leaf preserves the leaf intact', () => {
      expect(formatCanonicalUrn('node', 'acme.com::dev::review:sort-imports')).toBe(
        'hrn:node:acme.com::dev::review:sort-imports',
      );
    });

    it('canonical bare with 3 hierarchy levels passes through unchanged', () => {
      expect(formatCanonicalUrn('node', 'acme.com::dev::services')).toBe(
        'hrn:node:acme.com::dev::services',
      );
    });
  });

  describe('R2 install URNs (FR-014)', () => {
    it('round-trips an R2-shaped agent install URN without corrupting the author segment', () => {
      // R2 form: urn:agent:<install-org>::<app-slug>::<author-org>:<author-slug>
      // The author-org/author-slug pair lives INSIDE a single path-segment,
      // separated by `:` not `::`. A naive "replace all `:` with `::`" would
      // corrupt this; the parser must split on `::` first and leave the
      // inner `:` alone.
      const bare = 'micromentor.org::coding-app::hadronmemory.com:coding-agent';
      expect(formatCanonicalUrn('agent', bare)).toBe(
        'hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent',
      );
    });
  });

  describe('input validation', () => {
    it('throws on empty bareValue', () => {
      expect(() => formatCanonicalUrn('memory', '')).toThrow(UrnParseError);
      try {
        formatCanonicalUrn('memory', '');
      } catch (e) {
        expect((e as UrnParseError).reason).toBe('empty-bare-value');
      }
    });

    it('throws on whitespace-only bareValue', () => {
      expect(() => formatCanonicalUrn('memory', '   ')).toThrow(UrnParseError);
      try {
        formatCanonicalUrn('memory', '   ');
      } catch (e) {
        expect((e as UrnParseError).reason).toBe('empty-bare-value');
      }
    });

    it('throws when bareValue already includes urn: prefix', () => {
      expect(() => formatCanonicalUrn('memory', 'urn:memory:foo::bar')).toThrow(UrnParseError);
      try {
        formatCanonicalUrn('memory', 'urn:memory:foo::bar');
      } catch (e) {
        expect((e as UrnParseError).reason).toBe('already-prefixed-bare-value');
      }
    });

    it('propagates UrnParseError on unknown type', () => {
      // 'xyz' is not in the spec-021 D1 registry. parseUrn rejects.
      expect(() => formatCanonicalUrn('xyz' as never, 'foo')).toThrow(UrnParseError);
    });

    it('rejects bareValue carrying legacy loc: prefix', () => {
      // loc: is fully deprecated per spec-021 FR-021; parseUrn rejects.
      expect(() => formatCanonicalUrn('node', 'loc:foo:bar')).toThrow(UrnParseError);
    });
  });

  // Pins for the normalization rule added at src/lib/urn.ts:1140-1145.
  // The type-specific tests above exercise rewriting incidentally; this
  // block asserts the rule directly so a future refactor that reorders
  // normalization vs. parsing can't silently change the contract.
  describe('legacy-single-colon normalization (the rule)', () => {
    it('promotes legacy single-colon bare to canonical double-colon', () => {
      // The load-bearing positive case: input has no `::` anywhere, so
      // every `:` is a hierarchy separator and gets promoted.
      expect(formatCanonicalUrn('memory', 'acme.com:dev')).toBe(
        'hrn:memory:acme.com::dev',
      );
    });

    it('passes through any input that already contains `::`', () => {
      // The R2-install carve-out: once `::` appears, remaining `:` are
      // content (e.g., inside the author-segment of an install URN), not
      // hierarchy. Normalization stops touching them.
      expect(
        formatCanonicalUrn(
          'agent',
          'micromentor.org::coding-app::hadronmemory.com:coding-agent',
        ),
      ).toBe(
        'hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent',
      );
    });

    it('rejects partially-canonical mixed input via the parser', () => {
      // Input like `a:b::c` slips past the normalizer (it has `::`), but
      // the parser then rejects `a:b` as a non-spec segment shape for that
      // hierarchy position (FR-020). This is the chosen contract: the
      // normalizer doesn't second-guess mixed-form intent — it defers to
      // the parser's strict validation. Pinning the rejection here so a
      // future "helpful" normalizer rewrite can't silently swallow the
      // mixed form.
      expect(() => formatCanonicalUrn('node', 'a:b::c')).toThrow(
        UrnParseError,
      );
    });
  });

  describe('idempotence under canonicalization', () => {
    it('passing the output back through toParserCanonical yields the same string', () => {
      const out1 = formatCanonicalUrn('memory', 'acme.com:dev');
      const out2 = toParserCanonical(out1);
      expect(out1).toBe(out2);
    });

    it('applies cleanly to all valid type prefixes used by MCP', () => {
      // Spec 027 affects MCP-emitted URNs of these types.
      expect(formatCanonicalUrn('org', 'acme.com')).toBe('hrn:org:acme.com');
      expect(formatCanonicalUrn('memory', 'acme.com::dev')).toBe('hrn:memory:acme.com::dev');
      expect(formatCanonicalUrn('app', 'acme.com::coding')).toBe('hrn:app:acme.com::coding');
      expect(formatCanonicalUrn('agent', 'acme.com::coding-agent')).toBe(
        'hrn:agent:acme.com::coding-agent',
      );
      expect(formatCanonicalUrn('node', 'acme.com::dev::services:admin')).toBe(
        'hrn:node:acme.com::dev::services:admin',
      );
    });
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
    expect(result).toContain('got hrn:agent');
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

// =====================================================================
// Issue #239 — `hrn:` is canonical; legacy `urn:` accepted forever.
// =====================================================================
describe('parseUrn — scheme prefix (issue #239)', () => {
  it('emits canonical hrn: scheme for an hrn: input (no rewrite)', () => {
    const r = parseUrn('hrn:agent:hadronmemory.com::coding-agent');
    expect(r.parserCanonical).toBe('hrn:agent:hadronmemory.com::coding-agent');
    expect(r.parserRewrites).toEqual([]);
  });

  it('rewrites a legacy urn: input to canonical hrn: and flags legacy-urn-scheme', () => {
    const r = parseUrn('urn:agent:hadronmemory.com::coding-agent');
    expect(r.parserCanonical).toBe('hrn:agent:hadronmemory.com::coding-agent');
    expect(r.parserRewrites).toContain('legacy-urn-scheme');
  });

  it('legacy scheme composes with structural rewrites (both fire)', () => {
    const r = parseUrn(
      'urn:agent:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent',
    );
    expect(r.parserCanonical).toBe(
      'hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent',
    );
    expect([...r.parserRewrites].sort()).toEqual(
      ['legacy-urn-scheme', 'type-marker-optionality'].sort(),
    );
  });

  it('canonical hrn: output is idempotent (re-parse fires no rewrites)', () => {
    const once = parseUrn('urn:agent:hadronmemory.com::coding-agent').parserCanonical;
    const twice = parseUrn(once);
    expect(twice.parserCanonical).toBe(once);
    expect(twice.parserRewrites).toEqual([]);
  });

  it('isParserCanonical is false for a legacy urn: input (scheme rewrite needed)', () => {
    expect(isParserCanonical('urn:agent:hadronmemory.com::coding-agent')).toBe(false);
    expect(isParserCanonical('hrn:agent:hadronmemory.com::coding-agent')).toBe(true);
  });

  it('parseUrnInput accepts both schemes for the type marker', () => {
    expect(parseUrnInput('hrn:memory:acme.com:dev')).toEqual({ type: 'memory', value: 'acme.com:dev' });
    expect(parseUrnInput('urn:memory:acme.com:dev')).toEqual({ type: 'memory', value: 'acme.com:dev' });
  });

  it('formatCanonicalUrn rejects a bareValue carrying either scheme', () => {
    expect(() => formatCanonicalUrn('memory', 'hrn:memory:acme.com::dev')).toThrow(UrnParseError);
    expect(() => formatCanonicalUrn('memory', 'urn:memory:acme.com::dev')).toThrow(UrnParseError);
  });

  it('composeInstalledAgentUrn accepts legacy-scheme inputs and emits hrn:', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });
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
    expect(result.parserCanonical).toBe('hrn:agent:Hadronmemory.com::Coding-Agent');
  });
});

describe('toParserCanonical / isParserCanonical', () => {
  it('toParserCanonical returns the canonical form for a non-canonical input', () => {
    const canonical = toParserCanonical(
      'urn:agent:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent',
    );
    expect(canonical).toBe(
      'hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent',
    );
  });

  it('toParserCanonical is idempotent', () => {
    const once = toParserCanonical('urn:agent:micromentor.org::app:coding-app');
    const twice = toParserCanonical(once);
    expect(twice).toBe(once);
  });

  it('isParserCanonical returns true for already-canonical inputs', () => {
    // Canonical form carries the hrn: scheme (issue #239); a legacy urn:
    // input is non-canonical because it needs the scheme rewrite.
    expect(isParserCanonical('hrn:agent:hadronmemory.com::coding-agent')).toBe(true);
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
    // #352 added `anon` as a first-class role marker — assert against the
    // exported registry so this test can never drift behind the source list.
    expect(MEMORY_ROLE_MARKERS).toContain('anon');
    for (const word of MEMORY_ROLE_MARKERS) {
      expect(() => validateUserSlug(word)).toThrow(UrnParseError);
    }
  });

  // #575: slugs are lowercase-canonical at create/rename (URN lookups are
  // case-sensitive, so uppercase is a retrieval footgun).
  it('accepts lowercase slugs (incl. digits, dots, hyphens, underscores)', () => {
    for (const ok of ['acme', 'flow-lab', 'a.b.c', 'foo_bar', 'x9']) {
      expect(() => validateUserSlug(ok)).not.toThrow();
    }
  });

  it('rejects an uppercase slug as slug-not-lowercase (#575)', () => {
    for (const bad of ['Acme', 'Flow-Lab', 'fooBar', 'ABC']) {
      try {
        validateUserSlug(bad);
        throw new Error(`should have thrown for ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(UrnParseError);
        expect((e as UrnParseError).reason).toBe('slug-not-lowercase');
        // Message suggests the lowercased form.
        expect((e as UrnParseError).message).toContain(bad.toLowerCase());
      }
    }
  });

  it('a reserved word wins over the case check — "Agent" stays reserved-word-slug (#575)', () => {
    // Ordering guard: the case-insensitive reserved check runs before the
    // lowercase check, so a reserved word reports as reserved regardless of case.
    try {
      validateUserSlug('Agent');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as UrnParseError).reason).toBe('reserved-word-slug');
    }
  });
});

// #376: org slugs are stored BARE; a scheme-prefixed or colon-bearing value
// would cascade a corrupt `<orgUrn>:` prefix into every child URN.
describe('validateOrgSlug', () => {
  it('accepts a bare dotted org slug', () => {
    expect(() => validateOrgSlug('acme.com')).not.toThrow();
    expect(() => validateOrgSlug('sub.acme.co.uk')).not.toThrow();
  });

  it('#692: rejects an undotted org root', () => {
    expect(() => validateOrgSlug('personal-holger')).toThrow(UrnParseError);
    try {
      validateOrgSlug('acme');
    } catch (e) {
      expect((e as UrnParseError).reason).toBe('org-root-not-dotted');
    }
  });

  it('rejects a scheme prefix with the org-specific message', () => {
    for (const bad of ['hrn:org:acme', 'urn:org:acme']) {
      expect(() => validateOrgSlug(bad)).toThrow(UrnParseError);
      try {
        validateOrgSlug(bad);
      } catch (e) {
        expect((e as UrnParseError).reason).toBe('org-urn-not-bare');
        expect((e as UrnParseError).message).toMatch(/must be a bare slug/i);
      }
    }
  });

  it('rejects single- and double-colon values', () => {
    expect(() => validateOrgSlug('acme:foo')).toThrow(UrnParseError);
    expect(() => validateOrgSlug('acme::foo')).toThrow(UrnParseError);
  });

  it('still enforces charset and reserved-word rules from validateUserSlug', () => {
    expect(() => validateOrgSlug('bad space')).toThrow(UrnParseError);
    expect(() => validateOrgSlug('agent')).toThrow(UrnParseError); // reserved
  });

  it('inherits the lowercase-only rule from validateUserSlug (#575)', () => {
    expect(() => validateOrgSlug('acme.com')).not.toThrow();
    try {
      validateOrgSlug('Acme.com');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as UrnParseError).reason).toBe('slug-not-lowercase');
    }
  });
});

// #575: create/rename rejects uppercase slugs, but the PARSE path stays
// case-lenient so any pre-existing uppercase URN still resolves (Postel's law).
describe('parse path is case-lenient for uppercase slugs (#575)', () => {
  it('parses an uppercase URN without throwing', () => {
    expect(parseUrnInput('hrn:org:Acme')).toEqual({ type: 'org', value: 'Acme' });
    expect(parseUrnInput('urn:agent:hadronmemory.com:Flow-Lab')).toEqual({
      type: 'agent',
      value: 'hadronmemory.com:Flow-Lab',
    });
  });
});

// #574: display names slugify to a valid, lowercase URN atom before they're
// composed into a URN, so no create/rename path persists a raw name.
describe('deriveSlugFromName (#574)', () => {
  it.each([
    ['Flow Lab', 'flow-lab'],
    ['Acme', 'acme'],
    ['  Multiple   Spaces  ', 'multiple-spaces'],
    ['Juno Knowledge', 'juno-knowledge'],
    ['under_score-and-dash', 'under_score-and-dash'],
    ['v1.2.3', 'v1.2.3'], // dots are a legal atom char — preserved
    ['Trailing punctuation!!!', 'trailing-punctuation'],
    ['--leading-dashes', 'leading-dashes'],
    ['MiXeD CaSe 123', 'mixed-case-123'],
  ])('slugifies %j → %j', (name, expected) => {
    expect(deriveSlugFromName(name)).toBe(expected);
  });

  it('the derived slug always satisfies the create-time slug rules', () => {
    // Round-trip invariant: whatever comes out is lowercase + charset-legal, so
    // validateUserSlug accepts it (barring reserved words, which slugify keeps).
    for (const name of ['Flow Lab', 'Acme', 'v1.2', 'a  b  c', 'Wild!! Name??']) {
      expect(() => validateUserSlug(deriveSlugFromName(name))).not.toThrow();
    }
  });

  it('throws empty-derived-slug when nothing usable remains', () => {
    for (const bad of ['', '   ', '!!!', '---', '...']) {
      try {
        deriveSlugFromName(bad);
        throw new Error(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(UrnParseError);
        expect((e as UrnParseError).reason).toBe('empty-derived-slug');
      }
    }
  });

  it('does NOT reject a reserved word — slugify is not validation', () => {
    // A name like "System" derives to "system"; rejecting reserved slugs is the
    // caller's job (validateUserSlug), matching createApp's prior behavior.
    expect(deriveSlugFromName('System')).toBe('system');
  });

  it('caps the slug at the 64-char atom limit and re-trims (#587 review)', () => {
    const long = 'a'.repeat(100);
    const slug = deriveSlugFromName(long);
    expect(slug.length).toBe(64);
    // The capped slug must still satisfy the create-time atom rules (round-trip).
    expect(() => validateUserSlug(slug)).not.toThrow();

    // A cut that would land on trailing punctuation gets trimmed back to alnum.
    const trailing = 'x'.repeat(63) + '---tail';
    const s2 = deriveSlugFromName(trailing);
    expect(s2.length).toBe(63); // the 64th char was '-', trimmed
    expect(s2.endsWith('x')).toBe(true);
    expect(() => validateUserSlug(s2)).not.toThrow();
  });
});

// #352: every shape stored in Memory.urn must canonicalize to a form that
// round-trips through the strict spec-021 parser. The per-user (`user`) and
// anonymous (`anon`) runtime markers used to bypass the canonical-marker set,
// serving non-canonical URNs (PR #318 shipped without this coverage). Storage
// is now aligned to `app-user`/`anon`; these assert the read-side helper +
// parser agree.
describe('legacyMemoryUrnToCanonical — Memory.urn round-trip (#352)', () => {
  // [stored legacy form, expected bare canonical form]
  const STORED_SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['hadronmemory.com:specs', 'hadronmemory.com::specs'],
    ['micromentor.org:coding-agent:system', 'micromentor.org::coding-agent::system'],
    ['micromentor.org:coding-agent:app-user:abc123', 'micromentor.org::coding-agent::app-user:abc123'],
    ['micromentor.org:coding-agent:priv:abc123', 'micromentor.org::coding-agent::priv:abc123'],
    // The runtime per-user form AFTER the storage alignment (was `:user:`).
    ['micromentor.org:coding-agent:app-user:019dd', 'micromentor.org::coding-agent::app-user:019dd'],
    // Anonymous session — `anon` keeps its marker:id boundary (was severed to
    // `…::anon::id` before `anon` joined the marker registry).
    ['micromentor.org:coding-agent:anon:019dd', 'micromentor.org::coding-agent::anon:019dd'],
  ];

  for (const [stored, expectedBare] of STORED_SHAPES) {
    it(`canonicalizes + round-trips: ${stored}`, () => {
      const bare = legacyMemoryUrnToCanonical(stored);
      expect(bare).toBe(expectedBare);

      // The bare canonical wraps to a valid prefixed URN…
      const prefixed = formatCanonicalUrn('memory', bare);
      expect(prefixed).toBe(`hrn:memory:${expectedBare}`);

      // …and the prefixed URN parses cleanly (the acceptance criterion).
      expect(() => parseUrn(prefixed)).not.toThrow();
      expect(parseUrn(prefixed).parserCanonical).toBe(prefixed);
    });
  }

  it('preserves the marker:id boundary (does not sever marker from id)', () => {
    expect(legacyMemoryUrnToCanonical('org:agent:anon:id')).toBe('org::agent::anon:id');
    expect(legacyMemoryUrnToCanonical('org:agent:anon:id')).not.toContain('anon::id');
  });
});

// #352 review (gemini): runtime memory URNs are composed as
// `${org.urn}:${agentSlugFromUrn(agent.urn)}:<marker>:<id>`. The slug
// extraction must survive a normalized (canonical `::`) agent URN — a bare
// `split(':')` would emit a leading colon and mangle the memory URN.
describe('agentSlugFromUrn — robust to legacy + canonical agent URNs (#352)', () => {
  it('strips the org from a legacy single-colon agent URN', () => {
    expect(agentSlugFromUrn('micromentor.org:coding-agent')).toBe('coding-agent');
  });
  it('strips the org from a canonical double-colon agent URN (no leading colon)', () => {
    expect(agentSlugFromUrn('micromentor.org::coding-agent')).toBe('coding-agent');
    expect(agentSlugFromUrn('micromentor.org::coding-agent')).not.toContain(':coding-agent');
  });
  it('produces a memory URN that round-trips for a normalized agent URN', () => {
    const agentSlug = agentSlugFromUrn('micromentor.org::coding-agent');
    const memoryUrn = `micromentor.org:${agentSlug}:app-user:abc123`;
    expect(legacyMemoryUrnToCanonical(memoryUrn)).toBe(
      'micromentor.org::coding-agent::app-user:abc123',
    );
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
    ).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
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
    expect(a).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
    expect(b).toBe('hrn:agent:micromentor.org::coding-app::competitor.com:coding-agent');
  });

  it('install-by-self (installing org == author org) collapses via D11 cat 1', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:hadronmemory.com::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('hrn:agent:hadronmemory.com::coding-app::coding-agent');
  });

  // spec 047 — user-owned entities carry a @<handle> owner/author namespace.
  it('composes a user-owned app hosting an org-authored agent', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:@holger::gmail-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('hrn:agent:@holger::gmail-app::hadronmemory.com:coding-agent');
  });

  it('composes an org app hosting a user-authored agent (@handle author context)', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:agent:@holger::triage',
      ),
    ).toBe('hrn:agent:micromentor.org::coding-app::@holger:triage');
  });

  it('user self-install (user app == user agent author) collapses via cat 1', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:@holger::gmail-app',
        'urn:agent:@holger::triage',
      ),
    ).toBe('hrn:agent:@holger::gmail-app::triage');
  });

  it('accepts legacy single-`:` shapes (transitional during migration)', () => {
    // Pre-021 stored urns: `<org>:<slug>` without `urn:app:`/`urn:agent:` prefix.
    expect(
      composeInstalledAgentUrn(
        'micromentor.org:coding-app',
        'hadronmemory.com:coding-agent',
      ),
    ).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('accepts mixed grammar (legacy app, spec-021 agent)', () => {
    expect(
      composeInstalledAgentUrn(
        'micromentor.org:coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
  });

  it('accepts mixed grammar (spec-021 app, legacy agent)', () => {
    expect(
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'hadronmemory.com:coding-agent',
      ),
    ).toBe('hrn:agent:micromentor.org::coding-app::hadronmemory.com:coding-agent');
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
    ).toThrow(/hrn:app/);
  });

  it('throws on a wrong-type prefix on agentUrn', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:memory:hadronmemory.com::coding-agent',
      ),
    ).toThrow(/hrn:agent/);
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

  it('throws when appUrn has more than 2 segments (multi-segment inputs rejected)', () => {
    // Codex review: the prior helper version handled multi-segment
    // inputs by emitting `<org>::<sub>::<slug>` at the app slot, which
    // didn't match the FR-009 single-segment contract in the
    // installedAgentUrn GraphQL docstring. The helper now rejects
    // multi-segment inputs explicitly rather than silently emitting a
    // non-canonical URN.
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::sub::coding-app',
        'urn:agent:hadronmemory.com::coding-agent',
      ),
    ).toThrow(/2 segments/);
  });

  it('throws when agentUrn has more than 2 segments', () => {
    expect(() =>
      composeInstalledAgentUrn(
        'urn:app:micromentor.org::coding-app',
        'urn:agent:hadronmemory.com::sub::coding-agent',
      ),
    ).toThrow(/2 segments/);
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
      'hrn:node:micromentor.org::coding-app::coding-agent::system::app:settings',
    );
    expect(result.parserCanonical).toBe(
      'hrn:node:micromentor.org::coding-app::coding-agent::system::app:settings',
    );
    expect(result.parserRewrites).toEqual([]);
  });

  it('preserves a node leaf with a multi-atom path beginning with agent:', () => {
    const result = parseUrn(
      'hrn:node:micromentor.org::coding-app::coding-agent::system::agent:profile:bio',
    );
    expect(result.parserCanonical).toBe(
      'hrn:node:micromentor.org::coding-app::coding-agent::system::agent:profile:bio',
    );
    expect(result.parserRewrites).toEqual([]);
  });

  it('still strips type markers from intermediate node-URN segments', () => {
    // The leaf is exempt; intermediate segments still get cat 4 strip.
    const result = parseUrn(
      'urn:node:micromentor.org::app:coding-app::agent:hadronmemory.com:coding-agent::system::review:sort-imports',
    );
    expect(result.parserCanonical).toBe(
      'hrn:node:micromentor.org::coding-app::hadronmemory.com:coding-agent::system::review:sort-imports',
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

// =====================================================================
// spec 022 — normalizeUrnForLookup (DB compat during 021 migration)
// =====================================================================

describe('normalizeUrnForLookup', () => {
  it('collapses canonical `::` to legacy `:` form', () => {
    expect(normalizeUrnForLookup('acme.com::mmdata')).toBe('acme.com:mmdata');
  });
  it('passes legacy `:` form through unchanged', () => {
    expect(normalizeUrnForLookup('acme.com:mmdata')).toBe('acme.com:mmdata');
  });
  it('passes single-segment input through unchanged', () => {
    expect(normalizeUrnForLookup('acme.com')).toBe('acme.com');
  });
  it('collapses multi-level canonical to legacy', () => {
    expect(normalizeUrnForLookup('acme.com::coding-app::coding-agent')).toBe(
      'acme.com:coding-app:coding-agent',
    );
  });
});

// =====================================================================
// spec 022 — splitNodeUrn (signature collapse helper)
// =====================================================================

describe('splitNodeUrn', () => {
  it('splits a bare node URN with 3 atoms (org:memory:loc)', () => {
    expect(splitNodeUrn('acme.com:mmdata:review')).toEqual({
      memoryUrn: 'acme.com:mmdata',
      loc: 'review',
    });
  });

  it('splits a bare node URN with multi-atom loc', () => {
    expect(splitNodeUrn('acme.com:mmdata:review:sort-imports')).toEqual({
      memoryUrn: 'acme.com:mmdata',
      loc: 'review:sort-imports',
    });
  });

  it('splits a `urn:node:` prefixed bare URN', () => {
    expect(splitNodeUrn('urn:node:acme.com:mmdata:review:sort-imports')).toEqual({
      memoryUrn: 'acme.com:mmdata',
      loc: 'review:sort-imports',
    });
  });

  it('splits canonical `::` form (spec-021 hierarchy)', () => {
    expect(
      splitNodeUrn('urn:node:acme.com::mmdata::review:sort-imports'),
    ).toEqual({
      memoryUrn: 'acme.com:mmdata',
      loc: 'review:sort-imports',
    });
  });

  it('treats every `::` segment but the last as the MEMORY, not the loc', () => {
    // `a::b::c::d::e` is genuinely ambiguous — memory `a:b` with loc `c:d:e`,
    // or memory `a:b:c:d` with loc `e`? The v1 grammar cannot tell you. The
    // corpus (the cross-language contract) settles it the second way, and that
    // is the reading this platform needs: app-scoped memory URNs are
    // multi-segment by construction — `<org>:<app>:<agent>:app-mem:<slug>`,
    // `<org>:<agent>:app-user:<id>` (mintMemoryUrnV2.ts) — while loc atoms are
    // joined with a single `:`. Under the other reading every app-memory node
    // URN in `::` form resolves to a memory that does not exist.
    //
    // This expectation was inverted until urn-lib-js 0.0.15: it encoded the
    // pre-extraction local implementation, which predated app-scoped memories.
    expect(
      splitNodeUrn('urn:node:acme.com::mmdata::services::db-helpers::query'),
    ).toEqual({
      memoryUrn: 'acme.com:mmdata:services:db-helpers',
      loc: 'query',
    });
  });

  it('decomposes an app-scoped memory node URN — the case that forced the rule', () => {
    expect(
      splitNodeUrn('hrn:node:micromentor.org::coding-app::coding-agent::app-mem::a:b'),
    ).toEqual({
      memoryUrn: 'micromentor.org:coding-app:coding-agent:app-mem',
      loc: 'a:b',
    });
  });

  it('produces bare-form memoryUrn ready for DB lookup', () => {
    // `Memory.urn` is stored bare (`<org>:<memorySlug>`). The helper
    // normalizes to that form regardless of input grammar.
    expect(splitNodeUrn('acme.com:mmdata:loc').memoryUrn).toBe('acme.com:mmdata');
    expect(splitNodeUrn('urn:node:acme.com::mmdata::loc').memoryUrn).toBe('acme.com:mmdata');
  });

  it('accepts node-role-alias prefixes (D11 cat 2)', () => {
    // `urn:prompt:` and friends are aliases for `urn:node:` per spec 021.
    expect(
      splitNodeUrn('urn:prompt:acme.com::mmdata::review:sort-imports'),
    ).toEqual({
      memoryUrn: 'acme.com:mmdata',
      loc: 'review:sort-imports',
    });
  });

  // Self-validation: splitNodeUrn calls assertFullyQualifiedUrn internally
  // so call sites added outside the spec-022-reviewed handlers can't
  // silently produce wrong results.
  it('throws UrnNotQualifiedError on the motivating bug input', () => {
    expect(() => splitNodeUrn('review:sort-imports')).toThrow(UrnNotQualifiedError);
  });
  it('throws UrnNotQualifiedError on urn:loc: (deprecated)', () => {
    expect(() => splitNodeUrn('urn:loc:foo:bar')).toThrow(UrnNotQualifiedError);
  });
  it('throws UrnNotQualifiedError on a single-segment bare input', () => {
    expect(() => splitNodeUrn('foo')).toThrow(UrnNotQualifiedError);
  });
  it('throws UrnNotQualifiedError on a wrong-type prefix', () => {
    expect(() => splitNodeUrn('urn:org:acme.com')).toThrow(UrnNotQualifiedError);
  });
});

// =====================================================================
// spec 022 — assertFullyQualifiedUrn (API-boundary qualification check)
// =====================================================================

describe('assertFullyQualifiedUrn — minimum-segment count per expectedType', () => {
  describe('expectedType = org (MIN_SEGMENTS = 1)', () => {
    it('accepts bare org slug', () => {
      expect(() => assertFullyQualifiedUrn('acme.com', 'org')).not.toThrow();
    });
    it('accepts prefixed urn:org:slug', () => {
      expect(() => assertFullyQualifiedUrn('urn:org:acme.com', 'org')).not.toThrow();
    });
    it('rejects empty input', () => {
      expect(() => assertFullyQualifiedUrn('', 'org')).toThrow(UrnNotQualifiedError);
    });
  });

  describe('expectedType = memory (MIN_SEGMENTS = 2)', () => {
    it('accepts bare org:memory', () => {
      expect(() => assertFullyQualifiedUrn('acme.com:mmdata', 'memory')).not.toThrow();
    });
    it('accepts canonical urn:memory:org::memory', () => {
      expect(() => assertFullyQualifiedUrn('urn:memory:acme.com::mmdata', 'memory')).not.toThrow();
    });
    it('rejects bare single-segment input as memory URN', () => {
      const err = expect(() => assertFullyQualifiedUrn('mmdata', 'memory'));
      err.toThrow(UrnNotQualifiedError);
      err.toThrow(/not fully qualified/);
    });
    it('rejects with `expectedType` populated on the error', () => {
      try {
        assertFullyQualifiedUrn('mmdata', 'memory');
        expect.fail('expected UrnNotQualifiedError');
      } catch (e) {
        expect(e).toBeInstanceOf(UrnNotQualifiedError);
        expect((e as UrnNotQualifiedError).expectedType).toBe('memory');
        expect((e as UrnNotQualifiedError).offendingValue).toBe('mmdata');
      }
    });
  });

  describe('expectedType = agent (MIN_SEGMENTS = 2)', () => {
    it('accepts bare org:agent-slug', () => {
      expect(() => assertFullyQualifiedUrn('acme.com:coding-agent', 'agent')).not.toThrow();
    });
    it('accepts prefixed urn:agent:org::slug', () => {
      expect(() => assertFullyQualifiedUrn('urn:agent:acme.com::coding-agent', 'agent')).not.toThrow();
    });
    it('rejects bare single segment', () => {
      expect(() => assertFullyQualifiedUrn('coding-agent', 'agent')).toThrow(UrnNotQualifiedError);
    });
  });

  describe('expectedType = app (MIN_SEGMENTS = 2)', () => {
    it('accepts bare org:app-slug', () => {
      expect(() => assertFullyQualifiedUrn('acme.com:dev-app', 'app')).not.toThrow();
    });
    it('rejects bare single segment', () => {
      expect(() => assertFullyQualifiedUrn('dev-app', 'app')).toThrow(UrnNotQualifiedError);
    });
  });

  describe('expectedType = node (MIN_SEGMENTS = 3)', () => {
    it('accepts bare org:memory:loc', () => {
      expect(() => assertFullyQualifiedUrn('acme.com:mmdata:review:sort-imports', 'node')).not.toThrow();
    });
    it('accepts canonical urn:node:org::memory::loc', () => {
      expect(() =>
        assertFullyQualifiedUrn('urn:node:acme.com::mmdata::review:sort-imports', 'node'),
      ).not.toThrow();
    });
    it('rejects the motivating safety case: bare review:sort-imports (2 atoms)', () => {
      // This is THE bug spec 022 exists to prevent — a relative-form node
      // URN that an agent might construct from active-memory + loc. A naïve
      // segCount >= 2 check would accept this. The type-aware MIN_SEGMENTS
      // lookup catches it.
      try {
        assertFullyQualifiedUrn('review:sort-imports', 'node');
        expect.fail('expected UrnNotQualifiedError for bare review:sort-imports');
      } catch (e) {
        expect(e).toBeInstanceOf(UrnNotQualifiedError);
        const err = e as UrnNotQualifiedError;
        expect(err.offendingValue).toBe('review:sort-imports');
        expect(err.expectedType).toBe('node');
        expect(err.message).toContain('not fully qualified');
        expect(err.message).toContain('3 hierarchy segments');
      }
    });
    it('rejects bare 1-segment input as node URN', () => {
      expect(() => assertFullyQualifiedUrn('review', 'node')).toThrow(UrnNotQualifiedError);
    });
  });
});

describe('assertFullyQualifiedUrn — type-marker consistency', () => {
  it('rejects urn:org:foo when expectedType=memory (silent coercion guard)', () => {
    expect(() => assertFullyQualifiedUrn('urn:org:acme.com', 'memory')).toThrow(UrnNotQualifiedError);
  });
  it('rejects urn:memory:org::mem when expectedType=agent', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:memory:acme.com::mmdata', 'agent'),
    ).toThrow(UrnNotQualifiedError);
  });
  it('rejects urn:agent:org::slug when expectedType=app', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:agent:acme.com::coding-agent', 'app'),
    ).toThrow(UrnNotQualifiedError);
  });
});

describe('assertFullyQualifiedUrn — D11 cat 2 node-role aliases accepted for expectedType=node', () => {
  it('accepts urn:prompt: prefix when expectedType=node', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:prompt:acme.com::mmdata::review:sort-imports', 'node'),
    ).not.toThrow();
  });
  it('accepts urn:review: prefix when expectedType=node', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:review:acme.com::mmdata::sort-imports', 'node'),
    ).not.toThrow();
  });
  it('accepts urn:chat: prefix when expectedType=node', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:chat:acme.com::mmdata::session-1', 'node'),
    ).not.toThrow();
  });
  it('still rejects urn:prompt: when expectedType is NOT node', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:prompt:acme.com::mmdata::review:sort-imports', 'memory'),
    ).toThrow(UrnNotQualifiedError);
  });
});

describe('assertFullyQualifiedUrn — mixed-separator robustness', () => {
  it('accepts canonical `::` form for a node URN', () => {
    expect(() =>
      assertFullyQualifiedUrn('urn:node:acme.com::mmdata::review:sort-imports', 'node'),
    ).not.toThrow();
  });
  it('accepts bare `:` form for a node URN (legacy compat during migration)', () => {
    expect(() =>
      assertFullyQualifiedUrn('acme.com:mmdata:review:sort-imports', 'node'),
    ).not.toThrow();
  });
  it('counts segments correctly in mixed-separator bare form (prefers `::` if present)', () => {
    // `org::memory::loc` has 3 `::`-segments → passes node MIN=3.
    expect(() =>
      assertFullyQualifiedUrn('acme.com::mmdata::review:sort-imports', 'node'),
    ).not.toThrow();
  });
});

describe('assertFullyQualifiedUrn — explicit rejection of deprecated / malformed prefix shapes', () => {
  it('rejects urn:loc: prefix (deprecated entirely per spec 021 FR-021)', () => {
    // `loc:` is not a valid URN type — it was a pre-021 sugar for relative
    // node refs. Spec 022 rejects it at the API boundary regardless of
    // expectedType.
    expect(() => assertFullyQualifiedUrn('urn:loc:foo', 'node')).toThrow(UrnNotQualifiedError);
    expect(() => assertFullyQualifiedUrn('urn:loc:foo', 'memory')).toThrow(UrnNotQualifiedError);
  });

  it('rejects urn::foo (malformed prefix — no type marker)', () => {
    expect(() => assertFullyQualifiedUrn('urn::foo', 'memory')).toThrow(UrnNotQualifiedError);
  });

  it('rejects urn: with nothing after (degenerate)', () => {
    expect(() => assertFullyQualifiedUrn('urn:', 'memory')).toThrow(UrnNotQualifiedError);
  });
});

describe('assertFullyQualifiedUrn — empty-segment guard on bare form', () => {
  it('rejects leading colon', () => {
    expect(() => assertFullyQualifiedUrn(':foo', 'memory')).toThrow(UrnNotQualifiedError);
  });
  it('rejects trailing colon', () => {
    expect(() => assertFullyQualifiedUrn('acme.com:', 'memory')).toThrow(UrnNotQualifiedError);
  });
  it('rejects consecutive colons in mixed form', () => {
    // `acme.com:::mmdata` — single `::` would be canonical, but 3 colons creates
    // an empty segment under the `:` fallback (and `::` split also yields empty).
    expect(() => assertFullyQualifiedUrn('acme.com:::mmdata', 'memory')).toThrow(
      UrnNotQualifiedError,
    );
  });
});

describe('UrnNotQualifiedError — message shape', () => {
  it('embeds offendingValue in the message', () => {
    const err = new UrnNotQualifiedError('review:sort-imports', undefined, 'node');
    expect(err.message).toContain('"review:sort-imports"');
  });
  it('cites the expectedType in the fix hint', () => {
    const err = new UrnNotQualifiedError('mmdata', undefined, 'memory');
    expect(err.message).toContain('memory URN');
    expect(err.message).toContain('2 hierarchy segments');
  });
  it('falls back to a generic fix hint when expectedType is undefined', () => {
    const err = new UrnNotQualifiedError('mmdata');
    expect(err.message).toContain('canonical form');
  });
  it('has .name = UrnNotQualifiedError', () => {
    const err = new UrnNotQualifiedError('foo', undefined, 'memory');
    expect(err.name).toBe('UrnNotQualifiedError');
  });
});

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
