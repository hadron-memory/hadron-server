/**
 * Migration backfill test for spec 005-agent-subscription.
 *
 * Verifies the FR-010 backfill rules from the migration's UPDATE
 * statements. Approach: drop the NOT NULL on `class` and the CHECK
 * constraint temporarily, set up a fixture that mirrors a pre-spec
 * state (rows with class=NULL), run the migration's UPDATE statements
 * verbatim, restore the schema invariants, and assert the resulting
 * classification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test';

let pgClient: Client;

beforeEach(async () => {
  await cleanDb(db);
  pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  // Loosen schema invariants so we can simulate pre-spec state
  await pgClient.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_personal_visibility_user`);
  await pgClient.query(`ALTER TABLE memories ALTER COLUMN class DROP NOT NULL`);
});

afterEach(async () => {
  // Restore the schema invariants for the next test
  await pgClient.query(`UPDATE memories SET class = 'knowledge' WHERE class IS NULL`);
  await pgClient.query(`ALTER TABLE memories ALTER COLUMN class SET NOT NULL`);
  await pgClient.query(`
    ALTER TABLE memories ADD CONSTRAINT chk_personal_visibility_user
      CHECK ((visibility = 'PERSONAL') = (user_id IS NOT NULL))
  `);
  await pgClient.end();
});

async function runBackfillSql() {
  // The migration's UPDATE statements verbatim — see
  // prisma/migrations/<timestamp>_agent_subscription/migration.sql
  await pgClient.query(`
    UPDATE memories SET class = 'system'
    WHERE id IN (SELECT system_memory_id FROM agents WHERE system_memory_id IS NOT NULL)
  `);
  await pgClient.query(`
    UPDATE memories SET class = 'personal'
    WHERE user_memory_of_agent_id IS NOT NULL
  `);
  await pgClient.query(`UPDATE memories SET class = 'knowledge' WHERE class IS NULL`);
  await pgClient.query(`
    UPDATE memories AS m
       SET user_id = (
         SELECT s.user_id FROM sessions s
          WHERE s.memory_id = m.id AND s.user_id IS NOT NULL
          ORDER BY s.started_at ASC LIMIT 1
       ),
       visibility = 'PERSONAL'
     WHERE m.class = 'personal'
  `);
  await pgClient.query(`
    UPDATE memories
       SET class = 'knowledge', visibility = 'PRIVATE'
     WHERE class = 'personal' AND user_id IS NULL
  `);
}

describe('Memory.class backfill (FR-010)', () => {
  it('classifies system / personal / knowledge memories per the rules', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'bf-org', urn: 'bf-org' },
    });
    const sysMemory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:sys`, name: 'sys', class: 'knowledge' },
    });
    const knowledgeMemory = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:kb`, name: 'kb', class: 'knowledge' },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a', systemMemoryId: sysMemory.id },
    });
    const personalMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:pm`, name: 'pm',
        class: 'knowledge', userMemoryOfAgentId: agent.id,
      },
    });

    // Simulate pre-spec state: NULL all the test rows' classes
    await pgClient.query(
      `UPDATE memories SET class = NULL WHERE id IN ($1, $2, $3)`,
      [sysMemory.id, knowledgeMemory.id, personalMemory.id],
    );

    await runBackfillSql();

    const sysAfter = await db.memory.findUniqueOrThrow({ where: { id: sysMemory.id } });
    const knAfter = await db.memory.findUniqueOrThrow({ where: { id: knowledgeMemory.id } });
    const persAfter = await db.memory.findUniqueOrThrow({ where: { id: personalMemory.id } });

    expect(sysAfter.class).toBe('system');
    expect(knAfter.class).toBe('knowledge');
    // No session attribution → fallback demotes personal to knowledge
    expect(persAfter.class).toBe('knowledge');
    expect(persAfter.visibility).toBe('PRIVATE');
    expect(persAfter.userId).toBeNull();
  });

  it('preserves a personal memory whose first session attributes it to a user', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'bf-org-2', urn: 'bf-org-2' },
    });
    const user = await db.user.create({ data: { id: generateId(), githubId: 99002 } });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    const personalMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:pm`, name: 'pm',
        class: 'knowledge', userMemoryOfAgentId: agent.id,
      },
    });
    await db.session.create({
      data: {
        id: generateId(), type: 'CHATBOT', memoryId: personalMemory.id, userId: user.id, appId: null,
      },
    });

    await pgClient.query(`UPDATE memories SET class = NULL WHERE id = $1`, [personalMemory.id]);
    await runBackfillSql();

    const after = await db.memory.findUniqueOrThrow({ where: { id: personalMemory.id } });
    expect(after.class).toBe('personal');
    expect(after.visibility).toBe('PERSONAL');
    expect(after.userId).toBe(user.id);
  });
});
