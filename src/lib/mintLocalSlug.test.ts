/**
 * mintLocalSlug (#695) — deterministic, author-derived local-alias minting.
 * Pure unit tests: the `isTaken` probe is a set membership, so no DB.
 */
import { describe, it, expect } from 'vitest';
import { mintLocalSlug } from './mintLocalSlug.js';

/** A probe over a fixed set of already-claimed composed URNs. */
function taken(...claimed: string[]): (urn: string) => Promise<boolean> {
  const set = new Set(claimed);
  return (urn: string) => Promise.resolve(set.has(urn));
}

describe('mintLocalSlug', () => {
  it('keeps the desired slug when the composed URN is free', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: '@acme',
      isTaken: taken(),
    });
    expect(out).toEqual({ slug: 'notes', urn: '@holger:notes' });
  });

  it('falls back to a deterministic, author-derived alias on collision', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: 'acme.com',
      isTaken: taken('@holger:notes'),
    });
    // author-derived (the org/handle that authored the source), NOT random.
    expect(out).toEqual({ slug: 'notes-acme.com', urn: '@holger:notes-acme.com' });
  });

  it('strips a leading @ off the author root before deriving the suffix', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: '@merge-source',
      isTaken: taken('@holger:notes'),
    });
    expect(out.slug).toBe('notes-merge-source');
  });

  it('advances a numeric tail on repeat collision (still deterministic)', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: 'acme',
      isTaken: taken('@holger:notes', '@holger:notes-acme'),
    });
    expect(out.slug).toBe('notes-acme-2');
  });

  it('is deterministic — identical inputs yield the identical alias', async () => {
    const args = {
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: 'acme',
      isTaken: taken('@holger:notes'),
    };
    const a = await mintLocalSlug({ ...args });
    const b = await mintLocalSlug({ ...args });
    expect(a).toEqual(b);
  });

  it('caps an over-long desired slug on the keep-path even when free', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'a'.repeat(80),
      authorRoot: 'acme',
      isTaken: taken(),
    });
    expect(out.slug).toBe('a'.repeat(64));
    expect(out.urn).toBe(`@holger:${'a'.repeat(64)}`);
  });

  it('honors the 64-char atom cap by truncating the STEM, keeping the suffix intact', async () => {
    const cappedStem = 'a'.repeat(64); // the keep-path form of the 80-char input
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'a'.repeat(80),
      authorRoot: 'acme',
      isTaken: taken(`@holger:${cappedStem}`), // capped desired collides → alias
    });
    expect(out.slug.length).toBeLessThanOrEqual(64);
    expect(out.slug.endsWith('-acme')).toBe(true); // disambiguator survived
    expect(out.slug.startsWith('a')).toBe(true); // truncated stem, not dropped
  });

  it('caps a long author root so the suffix never eats the whole atom', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: 'code-generator-system-baragaun.com-extra-very-long-tail',
      isTaken: taken('@holger:notes'),
    });
    expect(out.slug.length).toBeLessThanOrEqual(64);
    expect(out.slug.startsWith('notes-')).toBe(true);
  });

  it('never adopts the foreign slug verbatim on collision', async () => {
    const out = await mintLocalSlug({
      root: '@holger',
      desiredSlug: 'notes',
      authorRoot: 'acme',
      isTaken: taken('@holger:notes'),
    });
    expect(out.slug).not.toBe('notes');
  });
});
