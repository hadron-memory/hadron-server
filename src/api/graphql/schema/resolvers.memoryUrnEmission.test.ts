/**
 * #872 — `Memory.urn` emits canonical grammar v2 for every stored shape.
 *
 * The resolver used to promote a single-colon stored urn to the spec-021 `::`
 * form (`legacyMemoryUrnToCanonical`) before emitting, behind an
 * `includes('::')` guard. Both were removed as redundant — `safeCanonicalUrn`
 * routes root entity types to `emitEntityUrnV2`, which collapses `::` and
 * strips an `@` sigil itself, so the promotion was undone immediately.
 *
 * This test is the proof, and the guard against someone reinstating either.
 * It asserts the OUTPUT for each stored shape, so it stays meaningful however
 * the inside is written.
 *
 * Note the asymmetry that made the old code look necessary:
 * `legacyMemoryUrnToCanonical` assumes SINGLE-COLON input — given
 * `acme.com::dev` it yields an empty atom and the emitter throws. So the
 * branch really was load-bearing *for the promotion*. Dropping the promotion
 * is what makes the branch droppable; dropping the branch alone would have
 * broken every `::`-stored row.
 */
import { describe, it, expect } from 'vitest';
import { resolvers } from './resolvers.js';
import { memoryRowToRef } from './publicRefs.js';

const urnOf = (stored: string) =>
  (resolvers.Memory as { urn: (g: { urn: string }) => string }).urn({ urn: stored });

describe('Memory.urn — canonical v2 emission (#872)', () => {
  // Column 1 describes the STORED shape, column 3 the EMITTED URN. `Memory.urn`
  // is stored BARE — no `hrn:` scheme prefix — so no stored row is ever
  // "already v2" in the emitted sense; the emitter always has work to do.
  // Keeping the two straight is the whole point of this resolver.
  it.each([
    ['flat single-colon (v2-shaped)', 'acme.com:dev', 'hrn:mem:acme.com:dev'],
    ['v1 `::` hierarchy', 'acme.com::dev', 'hrn:mem:acme.com:dev'],
    ['legacy `@` user sigil', '@holger:notes', 'hrn:mem:holger:notes'],
    ['user-rooted, no sigil', 'holger:notes', 'hrn:mem:holger:notes'],
    ['slug that echoes an old role', 'acme.com:mealplan-system', 'hrn:mem:acme.com:mealplan-system'],
  ])('emits v2 for a %s row', (_label, stored, expected) => {
    expect(urnOf(stored)).toBe(expected);
  });

  it('emits the same value whether the row is stored v1 or v2', () => {
    expect(urnOf('acme.com::dev')).toBe(urnOf('acme.com:dev'));
  });

  it('memoryRowToRef agrees with the field resolver', () => {
    for (const stored of ['acme.com:dev', 'acme.com::dev', '@holger:notes']) {
      expect(memoryRowToRef({ id: 'm1', name: 'n', urn: stored, shortDescription: null }).urn)
        .toBe(urnOf(stored));
    }
  });

  it('never emits a v1 `::` separator', () => {
    for (const stored of ['acme.com:dev', 'acme.com::dev', '@holger:notes']) {
      expect(urnOf(stored)).not.toContain('::');
    }
  });

  it('serves the raw stored value rather than throwing on an un-v2-able row', () => {
    // safeCanonicalUrn's catch: a corrupted row must not null out the whole
    // parent list (the myOrganizations 500 it was introduced for).
    expect(urnOf('acme.com::')).toBe('acme.com::');
  });
});
