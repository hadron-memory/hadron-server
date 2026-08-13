/**
 * Grammar-v2 URN emission helpers (#697 Stage 2). Pure — no DB.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  emitEntityUrnV2,
  emitNodeUrnV2,
  emitEdgeUrnV2,
  emitAssetUrnV2,
  emitInstalledAgentUrnV2,
  bestEffortFlatNodeUrn,
  safeNodeUrnV2,
  safeNodeUrnV2Result,
  safeEdgeUrnV2,
} from './urnEmit.js';

describe('urnEmit (v2 emission)', () => {
  it('emits memory with the `mem` type word, single colon', () => {
    expect(emitEntityUrnV2('memory', 'baragaun.com:secureid')).toBe('hrn:mem:baragaun.com:secureid');
  });

  it('strips a legacy `@` owner sigil', () => {
    expect(emitEntityUrnV2('memory', '@holger:notes')).toBe('hrn:mem:holger:notes');
    expect(emitEntityUrnV2('agent', '@holger:helper')).toBe('hrn:agent:holger:helper');
  });

  it('collapses a residual `::` stored form', () => {
    expect(emitEntityUrnV2('memory', 'acme.com::specs')).toBe('hrn:mem:acme.com:specs');
  });

  it('emits org / agent / app with unchanged type words', () => {
    expect(emitEntityUrnV2('org', 'baragaun.com')).toBe('hrn:org:baragaun.com');
    expect(emitEntityUrnV2('agent', 'acme.com:coder')).toBe('hrn:agent:acme.com:coder');
    expect(emitEntityUrnV2('app', 'acme.com:ops')).toBe('hrn:app:acme.com:ops');
  });

  it('emits node / edge as flat root:mem:loc', () => {
    expect(emitNodeUrnV2('acme.com:mmdata', 'review:sort-imports')).toBe(
      'hrn:node:acme.com:mmdata:review:sort-imports',
    );
    expect(emitEdgeUrnV2('acme.com:mmdata', 'intro:next')).toBe('hrn:edge:acme.com:mmdata:intro:next');
  });

  it('emits the v2 asset shape', () => {
    expect(emitAssetUrnV2('acme.com:mmdata', 'cl0abc')).toBe('hrn:asset:acme.com:mmdata:assets:cl0abc');
  });

  it('emits an installed agent as its author-rooted v2 URN (D10, no install chain)', () => {
    expect(emitInstalledAgentUrnV2('acme.com:coder')).toBe('hrn:agent:acme.com:coder');
  });

  it('throws on a corrupt (rootless) stored form so callers can fall back', () => {
    expect(() => emitEntityUrnV2('memory', '')).toThrow();
  });

  describe('bestEffortFlatNodeUrn (catch-path fallback)', () => {
    it('produces a single-colon hrn:node: URN for a simple stored memory urn', () => {
      expect(bestEffortFlatNodeUrn('node', 'acme.com:mmdata', 'review:sort')).toBe(
        'hrn:node:acme.com:mmdata:review:sort',
      );
    });

    it('collapses a residual v1 `::` and strips a legacy `@` owner sigil', () => {
      expect(bestEffortFlatNodeUrn('edge', '@holger:notes', 'intro:next')).toBe(
        'hrn:edge:holger:notes:intro:next',
      );
      expect(bestEffortFlatNodeUrn('node', 'acme.com::mmdata', 'loc')).toBe(
        'hrn:node:acme.com:mmdata:loc',
      );
    });

    it('never throws on a corrupt stored form (unlike the strict emitters)', () => {
      // A compound / not-yet-v2 stored urn that composeUrnV2 would reject still
      // yields a best-effort string here — the whole point of the fallback.
      expect(() => bestEffortFlatNodeUrn('node', '', 'loc')).not.toThrow();
    });
  });

  describe('safeNodeUrnV2 / safeEdgeUrnV2 (render-path emitters)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('is byte-identical to the strict emitter for well-formed data', () => {
      const mem = 'acme.com:mmdata';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(safeNodeUrnV2(mem, 'review:sort-imports')).toBe(emitNodeUrnV2(mem, 'review:sort-imports'));
      expect(safeEdgeUrnV2(mem, 'intro:next')).toBe(emitEdgeUrnV2(mem, 'intro:next'));
      expect(warn).not.toHaveBeenCalled();
    });

    // The regression this exists for: a stored loc with an EMPTY atom (leading,
    // trailing, or doubled ':') makes composeUrnV2 throw `invalid-segment-shape`.
    // On a render path that composes a URN per edge neighbour, one such row used
    // to fail the whole response with an error that blamed the CALLER's URN.
    it.each([['trailing', 'review:'], ['leading', ':review'], ['doubled', 'review::orphan']])(
      'does not throw on a %s-colon stored loc, and still returns an hrn:node: URN',
      (_label, loc) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => emitNodeUrnV2('acme.com:mmdata', loc)).toThrow(); // strict still rejects
        expect(safeNodeUrnV2('acme.com:mmdata', loc)).toMatch(/^hrn:node:acme\.com:mmdata:/);
      },
    );

    it('does not throw on a corrupt stored memory urn', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => safeNodeUrnV2('', 'review')).not.toThrow();
      expect(() => safeEdgeUrnV2('', 'intro:next')).not.toThrow();
    });

    // A memory's ROOT node has loc ''. Supported shape (git-sync maps it to the
    // repo-root README.md), so it must fall back WITHOUT being reported as
    // corruption — there is one per memory, so the warning would be both wrong
    // and constant, and it invites "repairing" a legitimate row.
    describe('root node (loc === "")', () => {
      it('falls back without logging a corruption warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = safeNodeUrnV2Result('acme.com:mmdata', '');
        expect(result.fellBack).toBe(true);
        expect(result.urn).toBe('hrn:node:acme.com:mmdata:');
        expect(warn).not.toHaveBeenCalled();
      });

      it('is still flagged as a fallback, so it never becomes a portal link', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The grammar has no root-node URN yet (cor:urn:010:01) — until it does,
        // the best-effort form must not be treated as addressable.
        expect(safeNodeUrnV2Result('acme.com:mmdata', '').fellBack).toBe(true);
      });

      it('still warns for a genuinely malformed loc (the suppression is narrow)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        safeNodeUrnV2Result('acme.com:mmdata', 'has space');
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });

    it('logs the stored loc and memory so the corrupt ROW can be located', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      safeNodeUrnV2('acme.com:mmdata', 'review:');
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0]!.join(' ');
      // The strict error names only the composed URN; these two are what an
      // operator needs to find the row, so assert they are present.
      expect(logged).toContain('"review:"');
      expect(logged).toContain('acme.com:mmdata');
      // ...and that it does not read as a caller-side problem.
      expect(logged).toContain('STORED');
    });
  });
});
