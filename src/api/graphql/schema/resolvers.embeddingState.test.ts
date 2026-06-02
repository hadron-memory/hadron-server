/**
 * Portal #257 — embedding-state + ack-timestamp GraphQL exposure.
 *
 * Sections 4 (node detail / list badges), 6 ("Vector index health" panel),
 * and the paragraph-3 ack-timestamp readback in #257 all need fields the
 * portal couldn't query because they weren't exposed in typeDefs. This
 * test pins:
 *
 *   - typeDefs declares the four new Node fields and the one new Memory
 *     field. A grep-based audit so any future contributor accidentally
 *     dropping them gets a loud failure at PR time.
 *
 *   - The Node and Memory DateTime resolvers serialize Prisma's `Date`
 *     into ISO strings (the GraphQL String! contract) and propagate
 *     null through unchanged.
 *
 *   - The static-string fields (embeddingError, embeddingAttempts) need
 *     no resolver coercion — Prisma returns the right shapes already —
 *     so the default-resolver path is sufficient. Pinned by absence
 *     here: this file does NOT declare a resolver for those fields,
 *     and the typeDefs audit confirms they're still declared.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

describe('Portal #257 — Node embedding-state fields exposed in GraphQL schema', () => {
  it('declares embeddingPendingAt: String on the Node type', () => {
    // Audit on the typeDefs source so any deletion fails this test
    // loudly. The shape (String, nullable) is the spec-033 contract:
    // null when the embed isn't pending (most live states); ISO
    // timestamp when set.
    expect(typeDefs).toMatch(/embeddingPendingAt:\s*String\b/);
  });

  it('declares embeddingFailedAt: String on the Node type', () => {
    expect(typeDefs).toMatch(/embeddingFailedAt:\s*String\b/);
  });

  it('declares embeddingError: String on the Node type', () => {
    expect(typeDefs).toMatch(/embeddingError:\s*String\b/);
  });

  it('declares embeddingAttempts: Int! on the Node type (non-null per Prisma default)', () => {
    expect(typeDefs).toMatch(/embeddingAttempts:\s*Int!/);
  });
});

describe('Portal #257 — Memory.vectorIndexEncryptedAckAt exposed in GraphQL schema', () => {
  it('declares vectorIndexEncryptedAckAt: String on the Memory type', () => {
    expect(typeDefs).toMatch(/vectorIndexEncryptedAckAt:\s*String\b/);
  });
});

describe('Node embedding-state DateTime resolvers — Date → ISO string', () => {
  it('embeddingPendingAt serializes a Prisma Date to ISO', () => {
    const date = new Date('2026-05-28T10:15:30.000Z');
    const out = (resolvers.Node as Record<string, unknown>).embeddingPendingAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ embeddingPendingAt: date })).toBe('2026-05-28T10:15:30.000Z');
  });

  it('embeddingPendingAt returns null for null input (most live states)', () => {
    const out = (resolvers.Node as Record<string, unknown>).embeddingPendingAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ embeddingPendingAt: null })).toBeNull();
  });

  it('embeddingPendingAt returns null for undefined input', () => {
    const out = (resolvers.Node as Record<string, unknown>).embeddingPendingAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({})).toBeNull();
  });

  it('embeddingFailedAt serializes a Prisma Date to ISO', () => {
    const date = new Date('2026-05-27T22:00:00.000Z');
    const out = (resolvers.Node as Record<string, unknown>).embeddingFailedAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ embeddingFailedAt: date })).toBe('2026-05-27T22:00:00.000Z');
  });

  it('embeddingFailedAt returns null for null input', () => {
    const out = (resolvers.Node as Record<string, unknown>).embeddingFailedAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ embeddingFailedAt: null })).toBeNull();
  });
});

describe('Memory.vectorIndexEncryptedAckAt resolver — Date → ISO string', () => {
  it('serializes a Prisma Date to ISO', () => {
    const date = new Date('2026-05-25T08:42:00.000Z');
    const out = (resolvers.Memory as Record<string, unknown>)
      .vectorIndexEncryptedAckAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ vectorIndexEncryptedAckAt: date })).toBe(
      '2026-05-25T08:42:00.000Z',
    );
  });

  it('returns null for unencrypted memories (or encrypted-but-never-enabled)', () => {
    const out = (resolvers.Memory as Record<string, unknown>)
      .vectorIndexEncryptedAckAt;
    if (typeof out !== 'function') throw new Error('expected resolver');
    expect(out({ vectorIndexEncryptedAckAt: null })).toBeNull();
  });
});

describe('Portal #257 — Prisma schema columns match GraphQL exposure', () => {
  // Cross-check: the GraphQL fields all need to back onto real columns
  // in the Prisma schema. If a future migration renames or drops one,
  // this test surfaces the drift before runtime.
  const schema = readFileSync(
    new URL('../../../../prisma/schema.prisma', import.meta.url),
    'utf8',
  );

  it.each([
    ['embeddingPendingAt'],
    ['embeddingFailedAt'],
    ['embeddingError'],
    ['embeddingAttempts'],
  ])('Node.%s column exists in prisma/schema.prisma', (column) => {
    // Match the Prisma column declaration shape: name + type.
    // Allow any whitespace + the @map directive that follows.
    expect(schema).toMatch(new RegExp(`\\b${column}\\s+\\w+`));
  });

  it('Memory.vectorIndexEncryptedAckAt column exists in prisma/schema.prisma', () => {
    expect(schema).toMatch(/\bvectorIndexEncryptedAckAt\s+DateTime\?/);
  });
});
