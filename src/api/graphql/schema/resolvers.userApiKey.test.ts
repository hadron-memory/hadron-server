/**
 * Spec 025-oauth-for-mcp FR-004: GraphQL resolver tests for
 * createUserApiKey + revokeUserApiKey + myUserApiKeys.
 *
 * Tasks T022 (createUserApiKey), T023 (revokeUserApiKey), T024
 * (myUserApiKeys) per tasks.md.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../../../middleware/auth.js';

let user: { id: string };
let otherUser: { id: string };

function userCtx(userId: string, overrides: Partial<Context> = {}): Context {
  return { db, userId, roles: ['READER'], ...overrides };
}

function appKeyCtx(appId: string, overrides: Partial<Context> = {}): Context {
  // AppKey-resolved caller: no userId set; matches what resolveAppKey
  // returns from src/middleware/auth.ts.
  return { db, appId, roles: [], ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      githubId: 1001,
      githubUsername: 'alice',
      name: 'Alice',
    },
  });
  otherUser = await db.user.create({
    data: {
      id: generateId(),
      handle: 'bob',
      githubId: 1002,
      githubUsername: 'bob',
      name: 'Bob',
    },
  });
});

// ── T022: createUserApiKey ──────────────────────────────────────────

describe('createUserApiKey', () => {
  it('mints a new user API key and returns the raw key exactly once', async () => {
    const result = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'cli scripts' },
      userCtx(user.id),
    )) as { userApiKey: { id: string; label: string | null; keyPreview: string }; rawKey: string };

    // Shape: rawKey is hdr_user_ + 64 hex chars (256 bits)
    expect(result.rawKey).toMatch(new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`));
    expect(result.userApiKey.label).toBe('cli scripts');
    expect(result.userApiKey.keyPreview).toBe(result.rawKey.slice(-4));

    // Persisted row matches expectations
    const persisted = await db.userApiKey.findUniqueOrThrow({
      where: { id: result.userApiKey.id },
    });
    expect(persisted.userId).toBe(user.id);
    expect(persisted.keyHash).toBe(hashUserApiKey(result.rawKey));
    expect(persisted.createdBy).toBe(user.id); // R-2: actor's User.id
    expect(persisted.issuedVia).toBe('portal'); // R-2: path discriminator
    expect(persisted.revokedAt).toBeNull();
  });

  it('rejects AppKey-resolved callers with UNAUTHENTICATED', async () => {
    await expect(
      resolvers.Mutation.createUserApiKey(
        undefined,
        { label: null },
        appKeyCtx('app-1'),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });

  it('accepts null label (portal default applied client-side)', async () => {
    const result = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: null },
      userCtx(user.id),
    )) as { userApiKey: { label: string | null } };
    expect(result.userApiKey.label).toBeNull();
  });

  it('rejects labels longer than the configured cap with BAD_USER_INPUT', async () => {
    // 200-char cap (PR #145 review): prevents users from stuffing
    // megabytes into the unbounded TEXT column.
    await expect(
      resolvers.Mutation.createUserApiKey(
        undefined,
        { label: 'x'.repeat(201) },
        userCtx(user.id),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('accepts a label exactly at the cap (200 chars)', async () => {
    const result = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'x'.repeat(200) },
      userCtx(user.id),
    )) as { userApiKey: { label: string | null } };
    expect(result.userApiKey.label).toBe('x'.repeat(200));
  });

  it('produces distinct hashes on repeated mints by the same user', async () => {
    const a = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'a' },
      userCtx(user.id),
    )) as { rawKey: string };
    const b = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'b' },
      userCtx(user.id),
    )) as { rawKey: string };
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(hashUserApiKey(a.rawKey)).not.toBe(hashUserApiKey(b.rawKey));
  });
});

// ── T023: revokeUserApiKey ──────────────────────────────────────────

describe('revokeUserApiKey', () => {
  async function mintKey(ownerId: string) {
    const result = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'test' },
      userCtx(ownerId),
    )) as { userApiKey: { id: string }; rawKey: string };
    return { id: result.userApiKey.id, rawKey: result.rawKey };
  }

  it('flips revokedAt on a key owned by the caller', async () => {
    const { id } = await mintKey(user.id);
    const result = (await resolvers.Mutation.revokeUserApiKey(
      undefined,
      { id },
      userCtx(user.id),
    )) as { id: string; revokedAt: Date | null };
    expect(result.revokedAt).not.toBeNull();

    const persisted = await db.userApiKey.findUniqueOrThrow({ where: { id } });
    expect(persisted.revokedAt).not.toBeNull();
  });

  it('is idempotent — re-revoking a revoked key returns it unchanged (no timestamp bump)', async () => {
    const { id } = await mintKey(user.id);
    const first = (await resolvers.Mutation.revokeUserApiKey(
      undefined,
      { id },
      userCtx(user.id),
    )) as { revokedAt: Date };
    const firstTs = first.revokedAt;

    const second = (await resolvers.Mutation.revokeUserApiKey(
      undefined,
      { id },
      userCtx(user.id),
    )) as { revokedAt: Date };

    expect(second.revokedAt.toISOString()).toBe(firstTs.toISOString());
  });

  it('rejects a cross-user revoke with NOT_FOUND (no id-enumeration channel)', async () => {
    // PR #145 review: an earlier draft returned FORBIDDEN for
    // valid-but-not-yours, which lets an attacker enumerate
    // UserApiKey.id values across the system (FORBIDDEN means "this
    // id exists, just isn't yours"). NOT_FOUND for both unknown-id
    // and not-yours closes the enumeration channel — the portal
    // never legitimately needs the distinction (myUserApiKeys only
    // returns the caller's own ids).
    const { id } = await mintKey(user.id);
    await expect(
      resolvers.Mutation.revokeUserApiKey(undefined, { id }, userCtx(otherUser.id)),
    ).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    // Key is still active — the attacker can't even tell whether
    // their guess was a hit.
    const persisted = await db.userApiKey.findUniqueOrThrow({ where: { id } });
    expect(persisted.revokedAt).toBeNull();
  });

  it('is race-safe under concurrent revocations (only one timestamp wins)', async () => {
    // PR #145 review: updateMany-with-conditional pattern prevents
    // two concurrent revocations from both bumping revokedAt. Both
    // calls succeed (idempotent), but the persisted revokedAt is
    // set exactly once.
    const { id } = await mintKey(user.id);
    const [a, b] = await Promise.all([
      resolvers.Mutation.revokeUserApiKey(undefined, { id }, userCtx(user.id)),
      resolvers.Mutation.revokeUserApiKey(undefined, { id }, userCtx(user.id)),
    ]) as Array<{ revokedAt: Date }>;
    // Both callers see a non-null revokedAt.
    expect(a.revokedAt).not.toBeNull();
    expect(b.revokedAt).not.toBeNull();
    // The persisted row matches what both callers returned (one
    // updateMany won, the other was a no-op).
    const persisted = await db.userApiKey.findUniqueOrThrow({ where: { id } });
    expect(persisted.revokedAt).not.toBeNull();
  });

  it('rejects a non-existent id with NOT_FOUND', async () => {
    await expect(
      resolvers.Mutation.revokeUserApiKey(
        undefined,
        { id: 'does-not-exist' },
        userCtx(user.id),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });

  it('rejects AppKey-resolved callers with UNAUTHENTICATED', async () => {
    const { id } = await mintKey(user.id);
    await expect(
      resolvers.Mutation.revokeUserApiKey(undefined, { id }, appKeyCtx('app-1')),
    ).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });
});

// ── T024: myUserApiKeys ─────────────────────────────────────────────

describe('myUserApiKeys', () => {
  it('returns only the calling user\'s keys (active + revoked) ordered DESC with id tiebreaker', async () => {
    // Create 3 keys for `user` (1 revoked) + 1 key for `otherUser`
    // (must not appear in caller's list). The resolver's orderBy
    // [createdAt DESC, id DESC] tiebreaker handles millisecond ties
    // deterministically; no setTimeout sleeps needed.
    const a = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'first' },
      userCtx(user.id),
    )) as { userApiKey: { id: string } };
    const b = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'second' },
      userCtx(user.id),
    )) as { userApiKey: { id: string } };
    const c = (await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'third' },
      userCtx(user.id),
    )) as { userApiKey: { id: string } };
    await resolvers.Mutation.revokeUserApiKey(
      undefined,
      { id: a.userApiKey.id },
      userCtx(user.id),
    );
    await resolvers.Mutation.createUserApiKey(
      undefined,
      { label: 'other-user-key' },
      userCtx(otherUser.id),
    );

    const result = (await resolvers.Query.myUserApiKeys(
      undefined,
      undefined,
      userCtx(user.id),
    )) as Array<{ id: string; label: string | null; revokedAt: Date | null }>;

    // 3 keys, all caller's own.
    expect(result).toHaveLength(3);
    expect(result.map((k) => k.id).sort()).toEqual(
      [a.userApiKey.id, b.userApiKey.id, c.userApiKey.id].sort(),
    );
    // Revoked key still appears with non-null revokedAt; active keys
    // do not (regardless of position).
    const aRow = result.find((k) => k.id === a.userApiKey.id);
    expect(aRow?.revokedAt).not.toBeNull();
    expect(result.find((k) => k.id === b.userApiKey.id)?.revokedAt).toBeNull();
    expect(result.find((k) => k.id === c.userApiKey.id)?.revokedAt).toBeNull();
  });

  it('returns an empty list when the caller has no keys', async () => {
    const result = (await resolvers.Query.myUserApiKeys(
      undefined,
      undefined,
      userCtx(user.id),
    )) as unknown[];
    expect(result).toEqual([]);
  });

  it('rejects AppKey-resolved callers with UNAUTHENTICATED', async () => {
    await expect(
      resolvers.Query.myUserApiKeys(undefined, undefined, appKeyCtx('app-1')),
    ).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });

  // PR #145 review removed the previous "does not surface keyHash"
  // test: it asserted the OPPOSITE of its name (verified that keyHash
  // IS in the resolver's row) and would silently pass even if someone
  // added `keyHash: String!` to type UserApiKey in typeDefs.ts. The
  // schema-layer field-filtering invariant is a property of GraphQL
  // itself, not something a resolver test can meaningfully assert.

  it('throws a GraphQLError for unauthenticated callers (matches the contract code)', async () => {
    // Belt-and-braces: confirm the error class and the extensions.code
    // field together (the appKeyCtx test above relies on
    // toMatchObject(.extensions); this asserts the thrown shape is
    // explicitly a GraphQLError, not a plain Error).
    await expect(
      resolvers.Query.myUserApiKeys(undefined, undefined, { db, roles: [] } as Context),
    ).rejects.toBeInstanceOf(GraphQLError);
  });
});
