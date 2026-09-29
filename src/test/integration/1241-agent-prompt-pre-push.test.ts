/** #1241: migrationless dev/test DBs must fold prompts before db push. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const prePushSql = readFileSync(new URL('../../../prisma/pre-push.sql', import.meta.url), 'utf8');
const transition = prePushSql.match(
  /-- ─── #1241:[\s\S]*?(DO \$\$[\s\S]*?END \$\$;)/,
)?.[1];
const schema = `prompt_prepush_${generateId().replaceAll('-', '')}`;

beforeAll(async () => {
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});

describe('#1241 Agent prompt pre-push transition', () => {
  it('preserves all old field shapes before db push and is safe to rerun', async () => {
    expect(transition).toBeTruthy();

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      // A fresh database has no agents table yet.
      await tx.$executeRawUnsafe(transition!);

      await tx.$executeRawUnsafe('CREATE TABLE agents (id TEXT PRIMARY KEY, system_prompt TEXT, persona_prompt TEXT)');
      await tx.$executeRawUnsafe(`
        INSERT INTO agents (id, system_prompt, persona_prompt) VALUES
          ('persona', NULL, 'Persona {{name}}.'),
          ('system', 'System text.', NULL),
          ('both', 'System text.', 'Persona {{name}}.'),
          ('neither', NULL, NULL)
      `);
      await tx.$executeRawUnsafe(transition!);
      await tx.$executeRawUnsafe(transition!);

      const rows = await tx.$queryRawUnsafe<Array<{ id: string; system_prompt: string | null }>>(
        'SELECT id, system_prompt FROM agents ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 'both', system_prompt: 'Persona {{name}}.\n\nSystem text.' },
        { id: 'neither', system_prompt: null },
        { id: 'persona', system_prompt: 'Persona {{name}}.' },
        { id: 'system', system_prompt: 'System text.' },
      ]);
      const columns = await tx.$queryRawUnsafe<Array<{ column_name: string }>>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'persona_prompt'",
      );
      expect(columns).toEqual([]);
    });
  });
});
