/**
 * #4524 — local/test databases use pre-push.sql rather than migration history.
 * `workers.signature` and `workers.trailer` are required with no default, so
 * `prisma db push` cannot add them to a populated `workers` table. Execute the
 * real transition block in a scratch schema: it must backfill the template
 * defaults the migration uses, and be a no-op everywhere else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const prePushSql = readFileSync(new URL('../../../prisma/pre-push.sql', import.meta.url), 'utf8');
const migrationSql = readFileSync(
  new URL('../../../prisma/migrations/20261019090000_worker_signature/migration.sql', import.meta.url),
  'utf8',
);
const transition = prePushSql.match(/-- ─── #4524:[\s\S]*?(DO \$\$[\s\S]*?END \$\$;)/)?.[1];

/** The two template literals, read from the migration so the block cannot drift from it. */
const migrationTemplates = (column: 'signature' | 'trailer'): string => {
  const match = migrationSql.match(new RegExp(`UPDATE workers SET ${column} = '([^']*)' WHERE ${column} IS NULL;`));
  if (!match) throw new Error(`migration has no ${column} backfill`);
  return match[1];
};

const schemas: string[] = [];
const scratch = async (): Promise<string> => {
  const name = `worker_sig_${generateId().replaceAll('-', '')}`;
  schemas.push(name);
  await db.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  return name;
};

afterAll(async () => {
  for (const name of schemas) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
});

beforeAll(() => {
  expect(transition, 'pre-push.sql carries the #4524 block').toBeTruthy();
});

const columnShape = (tx: Pick<typeof db, '$queryRawUnsafe'>) =>
  tx.$queryRawUnsafe<Array<{ column_name: string; column_default: string | null; is_nullable: string }>>(
    `SELECT column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'workers'
        AND column_name IN ('signature', 'trailer') ORDER BY column_name`,
  );

describe('#4524 pre-push workers.signature / workers.trailer transition', () => {
  it('backfills a populated workers table that lacks both columns, with no default left behind', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await tx.$executeRawUnsafe("INSERT INTO workers (id, name) VALUES ('w1', 'Ben'), ('w2', 'Gudrun')");

      await tx.$executeRawUnsafe(transition!);

      expect(await tx.$queryRawUnsafe('SELECT id, signature, trailer FROM workers ORDER BY id')).toEqual([
        { id: 'w1', signature: migrationTemplates('signature'), trailer: migrationTemplates('trailer') },
        { id: 'w2', signature: migrationTemplates('signature'), trailer: migrationTemplates('trailer') },
      ]);
      expect(await columnShape(tx)).toEqual([
        { column_name: 'signature', column_default: null, is_nullable: 'NO' },
        { column_name: 'trailer', column_default: null, is_nullable: 'NO' },
      ]);
    });
  });

  it('a second run changes nothing, including values a person has since edited', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await tx.$executeRawUnsafe("INSERT INTO workers (id, name) VALUES ('w1', 'Ben')");
      await tx.$executeRawUnsafe(transition!);
      await tx.$executeRawUnsafe("UPDATE workers SET signature = 'custom sig', trailer = 'custom trailer' WHERE id = 'w1'");

      await tx.$executeRawUnsafe(transition!);

      expect(await tx.$queryRawUnsafe('SELECT signature, trailer FROM workers')).toEqual([
        { signature: 'custom sig', trailer: 'custom trailer' },
      ]);
    });
  });

  it('is a no-op on a database whose workers table already has the columns', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(
        'CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, signature TEXT NOT NULL, trailer TEXT NOT NULL)',
      );
      await tx.$executeRawUnsafe("INSERT INTO workers VALUES ('w1', 'Ben', 'my sig', 'my trailer')");

      await tx.$executeRawUnsafe(transition!);

      expect(await tx.$queryRawUnsafe('SELECT signature, trailer FROM workers')).toEqual([
        { signature: 'my sig', trailer: 'my trailer' },
      ]);
    });
  });

  it('is a no-op when there is no workers table (a fresh database)', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe(transition!);
      expect(await tx.$queryRawUnsafe("SELECT to_regclass('workers')::text AS t")).toEqual([{ t: null }]);
    });
  });

  it('completes a table that has only one of the two columns', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL, signature TEXT NOT NULL)');
      await tx.$executeRawUnsafe("INSERT INTO workers VALUES ('w1', 'Ben', 'kept sig')");

      await tx.$executeRawUnsafe(transition!);

      expect(await tx.$queryRawUnsafe('SELECT signature, trailer FROM workers')).toEqual([
        { signature: 'kept sig', trailer: migrationTemplates('trailer') },
      ]);
    });
  });

  it('the production migration produces the same backfill (the two copies stay in step)', async () => {
    const schema = await scratch();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await tx.$executeRawUnsafe("INSERT INTO workers (id, name) VALUES ('w1', 'Ben')");
      const executable = migrationSql.replace(/^--.*$/gm, '');
      for (const statement of executable.split(';').map((part) => part.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(`${statement};`);
      }
      const viaMigration = await tx.$queryRawUnsafe('SELECT signature, trailer FROM workers');
      const viaMigrationShape = await columnShape(tx);

      await tx.$executeRawUnsafe('DROP TABLE workers');
      await tx.$executeRawUnsafe('CREATE TABLE workers (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
      await tx.$executeRawUnsafe("INSERT INTO workers (id, name) VALUES ('w1', 'Ben')");
      await tx.$executeRawUnsafe(transition!);

      expect(await tx.$queryRawUnsafe('SELECT signature, trailer FROM workers')).toEqual(viaMigration);
      expect(await columnShape(tx)).toEqual(viaMigrationShape);
    });
  });
});
