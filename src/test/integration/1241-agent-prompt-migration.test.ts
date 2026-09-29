/** Execute the shipped #1241 migration against all four old field shapes. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const migration = readFileSync(
  new URL('../../../prisma/migrations/20260928010000_agent_prompt_field/migration.sql', import.meta.url),
  'utf8',
);

describe('#1241 Agent prompt migration', () => {
  it('retains persona-only, system-only and both-field text in author order, then drops the old column', async () => {
    await cleanDb(db);
    const org = await db.organization.create({
      data: { id: generateId(), urn: `prompt-migration-${generateId()}`, name: 'prompt migration' },
    });
    const names = ['persona', 'system', 'both', 'neither'] as const;
    const agents = await Promise.all(names.map((name) => db.agent.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name,
        systemPrompt: name === 'system' || name === 'both' ? 'System text.' : null,
      },
    })));

    // db push builds the post-migration schema for test databases; restore the
    // old column here so the test executes the real migration file as shipped.
    await db.$executeRawUnsafe('ALTER TABLE "agents" ADD COLUMN "persona_prompt" TEXT');
    for (const agent of agents.filter((a) => a.name === 'persona' || a.name === 'both')) {
      await db.$executeRaw`UPDATE "agents" SET "persona_prompt" = ${'Persona {{name}}.'} WHERE "id" = ${agent.id}`;
    }
    const sql = migration.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }

    const rows = await db.agent.findMany({ where: { organizationId: org.id }, select: { name: true, systemPrompt: true } });
    expect(Object.fromEntries(rows.map((r) => [r.name, r.systemPrompt]))).toEqual({
      persona: 'Persona {{name}}.',
      system: 'System text.',
      both: 'Persona {{name}}.\n\nSystem text.',
      neither: null,
    });
    const columns = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'agents' AND column_name = 'persona_prompt'
    `;
    expect(columns).toEqual([]);
  });
});
