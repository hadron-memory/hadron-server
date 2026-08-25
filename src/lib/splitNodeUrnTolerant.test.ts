/**
 * The urn-lib-js 0.0.15 bump made the decomposer fragment-aware, which is right
 * for a URN a caller composed and wrong for one this server built from a ROW.
 * These pin both halves of that distinction.
 */
import { describe, it, expect } from 'vitest';
import { splitNodeUrnTolerant } from './splitNodeUrnTolerant.js';
import { UrnNotQualifiedError } from './urn.js';

describe('splitNodeUrnTolerant', () => {
  it('keeps a CORRUPT stored loc readable, marking it as corrupt', () => {
    // The row exists (it predates loc validation) and a read is how anyone
    // finds it. Straight through the library this throws, so the one row you
    // most need to see becomes the one row you cannot read.
    expect(splitNodeUrnTolerant('purl-org::purlmem::evil#@example.com')).toEqual({
      memoryUrn: 'purl-org:purlmem',
      loc: 'evil#@example.com',
      corruptFragment: true,
    });
  });

  it('leaves a REGISTERED #data fragment to the library, and does not mark it', () => {
    // Not the tolerant path: this decomposes cleanly, and the caller is meant
    // to see `fragment` and decide, rather than have it folded into the loc.
    expect(splitNodeUrnTolerant('hrn:node:acme.com:specs:cor:urn#data')).toEqual({
      memoryUrn: 'acme.com:specs',
      loc: 'cor:urn',
      fragment: 'data',
    });
  });

  it('passes an ordinary URN straight through', () => {
    expect(splitNodeUrnTolerant('hrn:node:acme.com::specs::cor:urn')).toEqual({
      memoryUrn: 'acme.com:specs',
      loc: 'cor:urn',
    });
  });

  it('still THROWS on a URN that is unqualified for any other reason', () => {
    // The recovery is scoped to the fragment refusal. A genuinely unqualified
    // URN must stay loud — answering it with a best-effort split turns a
    // correct refusal into a wrong lookup.
    expect(() => splitNodeUrnTolerant('acme.com::mmdata')).toThrow(UrnNotQualifiedError);
    expect(() => splitNodeUrnTolerant('not-a-urn')).toThrow();
  });

  it('does NOT rescue a URN whose defect is something OTHER than the fragment', () => {
    // The load-bearing property, and the reason this is safe: recovery retries
    // the LIBRARY on the text before the `#`, so it succeeds only where that
    // text is itself a valid node URN — i.e. exactly the corrupt-loc case.
    // A wrong entity kind or a malformed core still refuses, fragment or not.
    expect(() => splitNodeUrnTolerant('hrn:edge:acme.com:specs:a:b#data')).toThrow();
    expect(() => splitNodeUrnTolerant('hrn:node:BAD SEG#data')).toThrow();
    expect(() => splitNodeUrnTolerant('hrn:node:acme.com#data')).toThrow();
  });
});
