/**
 * Issue #300 (Option 3) — host-side bootstrap-token minting.
 *
 * Covers the require-existing-user contract: resolve by email / user-id /
 * handle, mint via the shared FR-015 path with the `admin` discriminator, and
 * refuse for unknown / deleted users or a bad selector.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { hashUserApiKey, USER_API_KEY_PREFIX } from '../middleware/auth.js';
import {
  mintBootstrapToken,
  BootstrapTokenError,
  BOOTSTRAP_TOKEN_LABEL,
} from './mint-bootstrap-token.js';

let user: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: {
      id: generateId(),
      handle: 'alice',
      email: 'alice@example.com',
      name: 'Alice',
      identityProvider: 'EMAIL',
    },
  });
});

describe('mintBootstrapToken', () => {
  it('mints a hdr_user_ token for an existing user (by email) and persists the audit shape', async () => {
    const { rawKey, user: returned } = await mintBootstrapToken(db, {
      email: 'alice@example.com',
    });

    expect(rawKey).toMatch(new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`));
    expect(returned.id).toBe(user.id);

    const persisted = await db.userApiKey.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(persisted.keyHash).toBe(hashUserApiKey(rawKey));
    expect(persisted.keyPreview).toBe(rawKey.slice(-4));
    expect(persisted.label).toBe(BOOTSTRAP_TOKEN_LABEL);
    expect(persisted.createdBy).toBe(user.id); // self-attributed (no admin identity on host)
    expect(persisted.issuedVia).toBe('admin'); // bootstrap discriminator
    expect(persisted.revokedAt).toBeNull();
  });

  it('resolves the user by --user-id', async () => {
    const { user: returned } = await mintBootstrapToken(db, { userId: user.id });
    expect(returned.id).toBe(user.id);
  });

  it('resolves the user by --handle', async () => {
    const { user: returned } = await mintBootstrapToken(db, { handle: 'alice' });
    expect(returned.id).toBe(user.id);
  });

  it('matches email case-insensitively (emails are stored lowercased)', async () => {
    const { user: returned } = await mintBootstrapToken(db, {
      email: '  Alice@Example.COM ',
    });
    expect(returned.id).toBe(user.id);
  });

  it('honors a custom label', async () => {
    await mintBootstrapToken(db, { email: 'alice@example.com' }, { label: 'my laptop' });
    const persisted = await db.userApiKey.findFirstOrThrow({ where: { userId: user.id } });
    expect(persisted.label).toBe('my laptop');
  });

  it('rejects when no selector is given', async () => {
    await expect(mintBootstrapToken(db, {})).rejects.toBeInstanceOf(BootstrapTokenError);
  });

  it('rejects when more than one selector is given', async () => {
    await expect(
      mintBootstrapToken(db, { email: 'alice@example.com', handle: 'alice' }),
    ).rejects.toBeInstanceOf(BootstrapTokenError);
  });

  it('rejects an unknown user without creating one (require-existing-user contract)', async () => {
    await expect(
      mintBootstrapToken(db, { email: 'nobody@example.com' }),
    ).rejects.toBeInstanceOf(BootstrapTokenError);

    // No user was created as a side effect.
    const count = await db.user.count();
    expect(count).toBe(1);
    // No stray token minted.
    expect(await db.userApiKey.count()).toBe(0);
  });

  it('refuses to mint for a soft-deleted user', async () => {
    await db.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    await expect(
      mintBootstrapToken(db, { userId: user.id }),
    ).rejects.toBeInstanceOf(BootstrapTokenError);
    expect(await db.userApiKey.count()).toBe(0);
  });
});
