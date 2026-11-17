/** #3042 additive migration and the documented drain-only prerequisite, isolated transactional schema. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { db } from '../db/client.js';
import { generateId } from '../../lib/id.js';

it('preserves legacy unknown branch, permits independent debts and proves old writers are incompatible', async () => {
  const schema = `mirror3042_${generateId()}`;
  const migration = readFileSync(fileURLToPath(new URL('../../../prisma/migrations/20261101073000_git_mirror_obligation_branch/migration.sql', import.meta.url)), 'utf8');
  await db.$transaction(async tx => {
    // Only our newly created private schema; transaction rollback removes it if a pin fails.
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
    await tx.$executeRawUnsafe(`CREATE TABLE git_mirror_obligations (
      memory_id text NOT NULL,node_id text NOT NULL,kind text NOT NULL,remove_loc text NOT NULL DEFAULT '',
      CONSTRAINT git_mirror_obligations_pkey PRIMARY KEY(memory_id,node_id,kind,remove_loc))`);
    await tx.$executeRaw`INSERT INTO git_mirror_obligations(memory_id,node_id,kind) VALUES ('memory','node','WRITE')`;
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    expect(await tx.$queryRaw`SELECT branch FROM git_mirror_obligations`).toEqual([{ branch: '' }]);
    await tx.$executeRaw`INSERT INTO git_mirror_obligations(memory_id,node_id,kind,branch) VALUES
      ('memory','node','WRITE','client/A'),('memory','node','WRITE','client/B')`;
    expect(await tx.$queryRaw`SELECT branch FROM git_mirror_obligations ORDER BY branch`).toEqual([{ branch: '' },{ branch: 'client/A' },{ branch: 'client/B' }]);
    // An old binary's upsert no longer has a matching unique target. Catch inside a savepoint so we can prove its delete too.
    await tx.$executeRawUnsafe('SAVEPOINT old_writer');
    let code: string | undefined;
    try {
      await tx.$executeRaw`INSERT INTO git_mirror_obligations(memory_id,node_id,kind,remove_loc) VALUES ('memory','node','WRITE','')
        ON CONFLICT(memory_id,node_id,kind,remove_loc) DO NOTHING`;
    } catch (error) { code = (error as { meta?: { code?: string } }).meta?.code; }
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT old_writer');
    expect(code).toBe('42P10');
    // Old success deletes do not fail: they erase ALL branches. This is why drain is a prerequisite, not safe coexistence.
    await tx.$executeRaw`DELETE FROM git_mirror_obligations WHERE memory_id='memory' AND node_id='node' AND kind='WRITE' AND remove_loc=''`;
    expect(await tx.$queryRaw`SELECT branch FROM git_mirror_obligations`).toEqual([]);
    await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }, { timeout: 30_000 });
});
