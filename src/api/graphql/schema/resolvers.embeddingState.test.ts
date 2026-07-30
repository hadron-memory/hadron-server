/**
 * Portal #257 — embedding-state + ack-timestamp GraphQL exposure.
 *
 * Sections 4 (node detail / list badges), 6 ("Vector index health" panel),
 * and the paragraph-3 ack-timestamp readback in #257 all need fields the
 * portal couldn't query because they weren't exposed in typeDefs. This
 * test pins:
 *
 *   - typeDefs declares the four new Node fields and the one new Memory
 *     field with the right nullability. A grep-based audit so any
 *     future contributor accidentally dropping or downgrading the
 *     fields gets a loud failure at PR time. Shapes:
 *       Node.embeddingPendingAt: DateTime (nullable — null when not pending)
 *       Node.embeddingFailedAt:  DateTime (nullable — null on success/never-failed)
 *       Node.embeddingError:     String   (nullable — null when no error recorded)
 *       Node.embeddingAttempts:  Int!     (non-null; Prisma default 0)
 *       Memory.vectorIndexEncryptedAckAt: DateTime (nullable)
 *
 *   - The three DateTime?-backed fields (Node.embeddingPendingAt,
 *     Node.embeddingFailedAt, Memory.vectorIndexEncryptedAckAt) turn Prisma's
 *     `Date` into an ISO string, with `null` propagating unchanged.
 *
 *     #205 changed the MECHANISM, not the contract: these used to carry
 *     hand-written per-field `toISO` resolvers, and now they are declared
 *     `DateTime` and coerced by that scalar. The assertions below moved with
 *     it — they pin the field TYPE plus the scalar's behaviour, and pin that
 *     no per-field resolver has crept back (one would silently take over the
 *     coercion and re-open the #204 bug surface on these three fields).
 *
 *   - embeddingError (String) and embeddingAttempts (Int!) are served by
 *     the default GraphQL field resolver — Prisma returns the right
 *     shapes natively. We pin that explicitly below so a future
 *     contributor who adds a resolver for either field (e.g. to mask
 *     credentials in the error message) is forced to remove the
 *     assertion and acknowledge the behavior change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { dateTimeScalar } from './dateTimeScalar.js';

describe('Portal #257 — Node embedding-state fields exposed in GraphQL schema', () => {
  it('declares embeddingPendingAt: DateTime on the Node type', () => {
    // Audit on the typeDefs source so any deletion fails this test
    // loudly. The shape (nullable timestamp) is the spec-033 contract:
    // null when the embed isn't pending (most live states); ISO
    // timestamp when set. `DateTime` (not String) since #205.
    expect(typeDefs).toMatch(/embeddingPendingAt:\s*DateTime\b/);
  });

  it('declares embeddingFailedAt: DateTime on the Node type', () => {
    expect(typeDefs).toMatch(/embeddingFailedAt:\s*DateTime\b/);
  });

  it('declares embeddingError: String on the Node type', () => {
    expect(typeDefs).toMatch(/embeddingError:\s*String\b/);
  });

  it('declares embeddingAttempts: Int! on the Node type (non-null per Prisma default)', () => {
    expect(typeDefs).toMatch(/embeddingAttempts:\s*Int!/);
  });
});

describe('Portal #257 — Memory.vectorIndexEncryptedAckAt exposed in GraphQL schema', () => {
  it('declares vectorIndexEncryptedAckAt: DateTime on the Memory type', () => {
    expect(typeDefs).toMatch(/vectorIndexEncryptedAckAt:\s*DateTime\b/);
  });
});

describe('Node embedding-state — default-resolver fields stay on the default path', () => {
  // PR-232 review (Copilot): "pinned by absence" isn't a real assertion.
  // Make it real. If a contributor adds a resolver for either field —
  // e.g. to mask credentials in embeddingError, or to clamp
  // embeddingAttempts on read — they must update this test to
  // acknowledge the behavior change. Prisma returns the right shapes
  // natively today (string + int), so the default resolver is correct.
  it('resolvers.Node.embeddingError is undefined (default field resolver applies)', () => {
    const node = resolvers.Node as Record<string, unknown>;
    expect(node.embeddingError).toBeUndefined();
  });

  it('resolvers.Node.embeddingAttempts is undefined (default field resolver applies)', () => {
    const node = resolvers.Node as Record<string, unknown>;
    expect(node.embeddingAttempts).toBeUndefined();
  });
});

describe('Node embedding-state timestamps — Date → ISO string (#205 scalar)', () => {
  // The coercion these fields depend on. Since #205 it lives in the shared
  // DateTime scalar instead of three copies of the same per-field resolver.
  const serialize = (v: unknown) => dateTimeScalar.serialize(v);

  it.each([
    ['embeddingPendingAt', new Date('2026-05-28T10:15:30.000Z'), '2026-05-28T10:15:30.000Z'],
    ['embeddingFailedAt', new Date('2026-05-27T22:00:00.000Z'), '2026-05-27T22:00:00.000Z'],
  ])('%s serializes a Prisma Date to ISO', (_field, date, iso) => {
    expect(serialize(date)).toBe(iso);
  });

  it('null propagates unchanged (most live states)', () => {
    expect(serialize(null)).toBeNull();
  });

  it('a missing property (undefined) resolves to null, not "undefined"', () => {
    expect(serialize(({} as Record<string, unknown>).embeddingPendingAt)).toBeNull();
  });

  it.each([['embeddingPendingAt'], ['embeddingFailedAt']])(
    'Node.%s has NO per-field resolver — the scalar owns the coercion',
    (field) => {
      // A resolver here would take over serialization and could reintroduce
      // the epoch-millis bug on this field alone. Deleting one is the fix;
      // if you genuinely need one, it must still return an ISO string.
      expect((resolvers.Node as Record<string, unknown>)[field]).toBeUndefined();
    },
  );
});

describe('Memory.vectorIndexEncryptedAckAt — Date → ISO string (#205 scalar)', () => {
  it('serializes a Prisma Date to ISO', () => {
    expect(dateTimeScalar.serialize(new Date('2026-05-25T08:42:00.000Z'))).toBe(
      '2026-05-25T08:42:00.000Z',
    );
  });

  it('returns null for unencrypted memories (or encrypted-but-never-enabled)', () => {
    expect(dateTimeScalar.serialize(null)).toBeNull();
  });

  it('has NO per-field resolver — the scalar owns the coercion', () => {
    expect(
      (resolvers.Memory as Record<string, unknown>).vectorIndexEncryptedAckAt,
    ).toBeUndefined();
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
