/**
 * #1261 — local/test databases use pre-push.sql rather than migration history.
 * Execute the real transition block in a scratch schema so outstanding OAuth
 * codes and existing OAuth-issued keys keep their historical account grant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const prePushSql = readFileSync(
  new URL('../../../prisma/pre-push.sql', import.meta.url),
  'utf8',
);
const transition = prePushSql.match(
  /-- ─── #1261:[\s\S]*?(DO \$\$[\s\S]*?END \$\$;)/,
)?.[1];
const schema = `oauth_prepush_${generateId().replaceAll('-', '')}`;

beforeAll(async () => {
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});

describe('#1261 pre-push OAuth-scope transition', () => {
  it('the real pre-push file contains the guarded transition', () => {
    expect(transition).toBeTruthy();
  });

  it('backfills only the old full-access rows and is idempotent', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE user_api_keys (id TEXT PRIMARY KEY, issued_via TEXT)');
      await tx.$executeRawUnsafe('CREATE TABLE auth_codes (id TEXT PRIMARY KEY)');
      await tx.$executeRawUnsafe(
        "INSERT INTO user_api_keys (id, issued_via) VALUES ('oauth-old', 'oauth:cli'), ('portal-old', 'portal')",
      );
      await tx.$executeRawUnsafe("INSERT INTO auth_codes (id) VALUES ('outstanding')");

      await tx.$executeRawUnsafe(transition!);
      const keys = await tx.$queryRawUnsafe<Array<{ id: string; oauth_scopes: string[] }>>(
        'SELECT id, oauth_scopes FROM user_api_keys ORDER BY id',
      );
      const codes = await tx.$queryRawUnsafe<Array<{ id: string; oauth_scopes: string[] }>>(
        'SELECT id, oauth_scopes FROM auth_codes ORDER BY id',
      );
      expect(keys).toEqual([
        { id: 'oauth-old', oauth_scopes: ['account'] },
        { id: 'portal-old', oauth_scopes: [] },
      ]);
      expect(codes).toEqual([{ id: 'outstanding', oauth_scopes: ['account'] }]);

      // A second setup run must not reinterpret a newly restricted grant.
      await tx.$executeRawUnsafe(
        "INSERT INTO user_api_keys (id, issued_via, oauth_scopes) VALUES ('oauth-new', 'oauth:cli', ARRAY['mcp']::TEXT[])",
      );
      await tx.$executeRawUnsafe("INSERT INTO auth_codes (id, oauth_scopes) VALUES ('new-code', ARRAY['mcp']::TEXT[])");
      await tx.$executeRawUnsafe(transition!);
      expect(await tx.$queryRawUnsafe('SELECT oauth_scopes FROM user_api_keys WHERE id = \'oauth-new\'')).toEqual([
        { oauth_scopes: ['mcp'] },
      ]);
      expect(await tx.$queryRawUnsafe('SELECT oauth_scopes FROM auth_codes WHERE id = \'new-code\'')).toEqual([
        { oauth_scopes: ['mcp'] },
      ]);
    });
  });
});
