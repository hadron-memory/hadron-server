/** Apply the actual additive migration to a legacy-shaped table in a rollback-only test transaction. */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey } from '../../../middleware/auth.js';

it('#1253 migration leaves legacy ancestry unknown and preserves credentials', async () => {
  await cleanDb(db);
  const userId = (await db.user.create({ data: { id: generateId(), githubId: 1253081 } })).id;
  const legacy = await mintUserApiKey(db, { userId, createdBy: userId, label: 'legacy', issuedVia: 'oauth:legacy' });
  const before = await db.userApiKey.findUniqueOrThrow({ where: { id: legacy.userApiKey.id } });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE user_api_keys DROP COLUMN minted_by_key_id CASCADE');
    await client.query(readFileSync(new URL('../../../../prisma/migrations/20261016053000_user_key_lineage/migration.sql', import.meta.url), 'utf8'));
    const result = await client.query('SELECT * FROM user_api_keys WHERE id = $1', [legacy.userApiKey.id]);
    expect(result.rows[0].minted_by_key_id).toBeNull();
    expect(result.rows[0].key_hash).toBe(before.keyHash);
    expect(result.rows[0].issued_via).toBe(before.issuedVia);
    expect(result.rows[0].oauth_scopes).toEqual(before.oauthScopes);
    const indexes = await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'user_api_keys' AND indexname = 'user_api_keys_minted_by_key_id_idx'");
    expect(indexes.rowCount).toBe(1);
    await expect(client.query('UPDATE user_api_keys SET minted_by_key_id = $1 WHERE id = $2', ['missing', legacy.userApiKey.id]))
      .rejects.toMatchObject({ code: '23503' });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
