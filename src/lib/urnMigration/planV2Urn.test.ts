/**
 * Pure slug planner for the URN-v2 backfill (#697) — extraction of the terminal
 * v2 slug + collision hint from every stored v1 URN shape. (The root comes from
 * the owner FK in the backfill, not from this string.)
 */
import { describe, it, expect } from 'vitest';
import { planV2Slug } from './planV2Urn.js';

describe('planV2Slug', () => {
  it('keeps the terminal atom of a simple org-rooted URN (no author hint)', () => {
    expect(planV2Slug('baragaun.com:secureid')).toEqual({
      desiredSlug: 'secureid',
      authorRootHint: null,
    });
  });

  it('ignores the @ sigil (owner comes from the FK) and keeps the slug', () => {
    expect(planV2Slug('@holger:my-stuff')).toEqual({
      desiredSlug: 'my-stuff',
      authorRootHint: null,
    });
  });

  it('treats an agent system memory (`-system` suffix) as one atom', () => {
    expect(planV2Slug('acme.com:code-gen-system')).toEqual({
      desiredSlug: 'code-gen-system',
      authorRootHint: null,
    });
  });

  it('collapses a per-user app-user marker URN to its terminal id, agent as author hint', () => {
    expect(planV2Slug('acme.com:code-gen:app-user:0192abc')).toEqual({
      desiredSlug: '0192abc',
      authorRootHint: 'code-gen',
    });
  });

  it('collapses an anon marker URN to its terminal id', () => {
    expect(planV2Slug('acme.com:code-gen:anon:0192def')).toEqual({
      desiredSlug: '0192def',
      authorRootHint: 'code-gen',
    });
  });

  it('collapses a 5-atom app-mem URN to its terminal slug', () => {
    expect(planV2Slug('acme.com:ops-app:code-gen:app-mem:shared-notes')).toEqual({
      desiredSlug: 'shared-notes',
      authorRootHint: 'ops-app',
    });
  });

  it('throws on an empty, single-atom, or empty-inner-atom URN (recorded as a failure)', () => {
    expect(() => planV2Slug('')).toThrow();
    expect(() => planV2Slug('just-a-root')).toThrow();
    expect(() => planV2Slug('acme.com::double')).toThrow(); // empty middle atom
  });
});
