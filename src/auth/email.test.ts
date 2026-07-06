/**
 * #505 — verifyMagicLink round-trips the session-fixation binding hash.
 *
 * sendMagicLink itself isn't exercised here (it calls Resend); we insert the
 * token row directly and assert verify returns the stored clientStateHash and
 * consumes the token. The mint side (POST /auth/email storing the hash) is
 * covered end-to-end by the integration suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { verifyMagicLink } from './email.js';

beforeEach(async () => {
  await cleanDb(db);
});

async function insertToken(overrides: Partial<{ token: string; clientStateHash: string | null; usedAt: Date; expiresAt: Date }> = {}) {
  const token = overrides.token ?? 'tok-' + generateId();
  await db.emailVerificationToken.create({
    data: {
      id: generateId(),
      email: 'user@example.test',
      token,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
      usedAt: overrides.usedAt ?? null,
      clientStateHash: overrides.clientStateHash ?? null,
    },
  });
  return token;
}

describe('verifyMagicLink', () => {
  it('returns the email and the stored clientStateHash (#505)', async () => {
    const token = await insertToken({ clientStateHash: 'abc123' });
    const result = await verifyMagicLink(token, db);
    expect(result).toEqual({ email: 'user@example.test', clientStateHash: 'abc123' });
  });

  it('returns clientStateHash null when the token carries none', async () => {
    const token = await insertToken({ clientStateHash: null });
    expect((await verifyMagicLink(token, db))?.clientStateHash).toBeNull();
  });

  it('consumes the token (single use)', async () => {
    const token = await insertToken({ clientStateHash: 'h' });
    expect(await verifyMagicLink(token, db)).not.toBeNull();
    expect(await verifyMagicLink(token, db)).toBeNull(); // usedAt now set
  });

  it('rejects an expired token', async () => {
    const token = await insertToken({ expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyMagicLink(token, db)).toBeNull();
  });
});
