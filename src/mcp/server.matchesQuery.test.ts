/**
 * Issue #170 — `matchesQuery` wildcard / match-all semantics for hadron_find_nodes.
 *
 * Pre-fix, `query: "*"` was treated as a literal substring and returned
 * "No nodes found matching '*'." even against a populated memory. An
 * agent surveying a memory would reasonably try "*" first, get zero
 * hits, and proceed to write — overlooking the existing tree.
 *
 * This file pins the survey-mode contract: `*` and trimmed-empty query
 * strings always match. Keyword behavior is otherwise unchanged.
 */

import { describe, it, expect } from 'vitest';
import { matchesQuery } from './server.js';

const node = {
  name: 'Architecture',
  loc: 'arch:overview',
  description: 'High-level system architecture notes.',
  tags: ['spec', 'p0'],
};

describe('matchesQuery — #170 wildcard / match-all', () => {
  it('returns true for query="*"', () => {
    expect(matchesQuery(node, '*')).toBe(true);
  });

  it('returns true for query="" (trimmed-empty)', () => {
    expect(matchesQuery(node, '')).toBe(true);
  });

  it('returns true for whitespace-only query', () => {
    expect(matchesQuery(node, '   ')).toBe(true);
  });

  it('returns true for "*" with surrounding whitespace', () => {
    expect(matchesQuery(node, '  *  ')).toBe(true);
  });

  it('still matches everything in a degenerate row (empty fields)', () => {
    // Pathological row with no indexable text — survey mode should
    // surface it anyway so the agent sees the row exists.
    const empty = { name: '', loc: '', description: null, tags: [] };
    expect(matchesQuery(empty, '*')).toBe(true);
    expect(matchesQuery(empty, '')).toBe(true);
  });
});

describe('matchesQuery — keyword behavior (unchanged)', () => {
  it('returns true when a single term appears in name', () => {
    expect(matchesQuery(node, 'architecture')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesQuery(node, 'ARCHITECTURE')).toBe(true);
  });

  it('matches against loc', () => {
    expect(matchesQuery(node, 'arch:overview')).toBe(true);
  });

  it('matches against description', () => {
    expect(matchesQuery(node, 'high-level')).toBe(true);
  });

  it('matches against tags', () => {
    expect(matchesQuery(node, 'spec')).toBe(true);
  });

  it('requires ALL whitespace-separated terms to appear', () => {
    // "spec" is in tags, "system" is in description — both present.
    expect(matchesQuery(node, 'spec system')).toBe(true);
    // "spec" is in tags, "missing" is nowhere.
    expect(matchesQuery(node, 'spec missing')).toBe(false);
  });

  it('returns false when no term matches', () => {
    expect(matchesQuery(node, 'database')).toBe(false);
  });

  it('does not treat `*` inside a multi-word query as a wildcard', () => {
    // Survey-mode is the WHOLE query being "*", not a token within it.
    // `* architecture` should fall through to substring matching: the
    // literal "*" doesn't appear in any field, so this is a miss.
    expect(matchesQuery(node, '* architecture')).toBe(false);
  });
});
