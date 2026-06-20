/**
 * Spec 037 — first-class edges. Unit coverage for the pure edge-loc /
 * edge-URN helpers. These have no DB dependency, so they pin the
 * derivation contract that the prod migration SQL backfill must mirror
 * (see prisma/migrations/*_edge_first_class/migration.sql).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeLocAtom, deriveEdgeLoc } from './edgeLoc.js';
import { validateLoc } from './validateLoc.js';
import { composeEdgeUrn, composeNodeUrn } from './urn.js';

describe('sanitizeLocAtom', () => {
  it('leaves an already-valid atom unchanged', () => {
    expect(sanitizeLocAtom('depends-on')).toBe('depends-on');
    expect(sanitizeLocAtom('abstract.of')).toBe('abstract.of');
    expect(sanitizeLocAtom('a')).toBe('a');
  });

  it('replaces out-of-charset characters (incl. the ":" separator) with "-"', () => {
    expect(sanitizeLocAtom('has space')).toBe('has-space');
    expect(sanitizeLocAtom('foo:bar')).toBe('foo-bar');
    expect(sanitizeLocAtom('a/b\\c')).toBe('a-b-c');
  });

  it('trims to alphanumeric ends', () => {
    expect(sanitizeLocAtom('!!foo!!')).toBe('foo');
    expect(sanitizeLocAtom('-leading')).toBe('leading');
    expect(sanitizeLocAtom('trailing-')).toBe('trailing');
  });

  it('falls back to "rel" when nothing usable remains', () => {
    expect(sanitizeLocAtom('')).toBe('rel');
    expect(sanitizeLocAtom(null)).toBe('rel');
    expect(sanitizeLocAtom(undefined)).toBe('rel');
    expect(sanitizeLocAtom('___')).toBe('rel');
    expect(sanitizeLocAtom('!!!')).toBe('rel');
  });

  it('caps the atom at 64 characters and re-trims a trailing non-alnum', () => {
    const out = sanitizeLocAtom('a'.repeat(70));
    expect(out).toHaveLength(64);
    expect(out).toBe('a'.repeat(64));
  });

  it('always returns a string that passes per-atom loc validation', () => {
    for (const input of ['depends on', 'foo!bar', '  spaced  ', 'x'.repeat(200), 'a:b:c']) {
      expect(() => validateLoc(sanitizeLocAtom(input))).not.toThrow();
    }
  });
});

describe('deriveEdgeLoc', () => {
  it('composes <sourceLoc>:<sanitized name>:<targetLoc>', () => {
    expect(deriveEdgeLoc('cor:dmo:060:03', 'depends-on', 'cor:dmo:060:02')).toBe(
      'cor:dmo:060:03:depends-on:cor:dmo:060:02',
    );
  });

  it('sanitizes the name segment but leaves the (already-valid) endpoint locs intact', () => {
    expect(deriveEdgeLoc('a', 'has space', 'b')).toBe('a:has-space:b');
  });

  it('uses "rel" when the name is null/empty', () => {
    expect(deriveEdgeLoc('a', null, 'b')).toBe('a:rel:b');
    expect(deriveEdgeLoc('a', '', 'b')).toBe('a:rel:b');
  });

  it('is deterministic — same inputs always yield the same loc (sync idempotency)', () => {
    const a = deriveEdgeLoc('guide', 'routes-to', 'topics:setup');
    const b = deriveEdgeLoc('guide', 'routes-to', 'topics:setup');
    expect(a).toBe(b);
  });

  it('is distinct exactly where the old (source,target,name) triple was', () => {
    const base = ['x', 'rel', 'y'] as const;
    expect(deriveEdgeLoc(...base)).toBe(deriveEdgeLoc(...base));
    expect(deriveEdgeLoc('x', 'rel', 'y')).not.toBe(deriveEdgeLoc('x', 'rel2', 'y'));
    expect(deriveEdgeLoc('x', 'rel', 'y')).not.toBe(deriveEdgeLoc('x', 'rel', 'z'));
    expect(deriveEdgeLoc('x', 'rel', 'y')).not.toBe(deriveEdgeLoc('w', 'rel', 'y'));
  });

  it('produces a valid loc', () => {
    expect(() => validateLoc(deriveEdgeLoc('cor:dmo', 'a b!c', 'x:y'))).not.toThrow();
  });
});

describe('composeEdgeUrn', () => {
  it('emits hrn:edge:<org>::<memory>::<loc>, the node-parallel shape', () => {
    expect(composeEdgeUrn('acme.com:dev', 'flow:step1:step2')).toBe(
      'hrn:edge:acme.com::dev::flow:step1:step2',
    );
  });

  it('accepts a canonical (::) memory URN identically to the bare form', () => {
    expect(composeEdgeUrn('acme.com::dev', 'x')).toBe(composeEdgeUrn('acme.com:dev', 'x'));
  });

  it('differs from the node URN only by the type word', () => {
    const node = composeNodeUrn('acme.com:dev', 'shared-loc');
    const edge = composeEdgeUrn('acme.com:dev', 'shared-loc');
    expect(node).toBe('hrn:node:acme.com::dev::shared-loc');
    expect(edge).toBe('hrn:edge:acme.com::dev::shared-loc');
  });
});
