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

// Prefer the per-worker DATABASE_URL (set by perWorkerDb.ts in parallel mode)
// so the raw pg client and the Prisma `db` above target the SAME database;
// falls back to TEST_DATABASE_URL / the default for the serial single-DB mode.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://holger@localhost:5432/hadron_test';

let pgClient: Client;

beforeEach(async () => {
  await cleanDb(db);
  pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  // Loosen schema invariants so we can simulate pre-spec state. 008's
  // chk_memory_class_app_id is dropped here too: the 005 backfill SQL
  // (replayed by these tests) doesn't know about app_id, so it can
  // briefly create class='personal' rows with app_id=NULL.
  await pgClient.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_personal_visibility_user`);
  await pgClient.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_class_app_id`);
  await pgClient.query(`ALTER TABLE memories ALTER COLUMN class DROP NOT NULL`);
});

afterEach(async () => {
  // Restore the schema invariants for the next test
  await pgClient.query(`UPDATE memories SET class = 'knowledge' WHERE class IS NULL`);
  // Belt-and-braces: any rows the test left with class IN ('app', 'personal')
  // and app_id IS NULL would block re-adding chk_memory_class_app_id. Since
  // these tests live in their own DB that isn't exercising the 008 app_id
  // pivot end-to-end, downgrade leftovers to knowledge so the constraint can
  // be re-added cleanly.
  await pgClient.query(`
    UPDATE memories SET class = 'knowledge', visibility = 'ORGANIZATION', user_id = NULL
    WHERE class IN ('app', 'personal') AND app_id IS NULL
  `);
  await pgClient.query(`ALTER TABLE memories ALTER COLUMN class SET NOT NULL`);
  // Restore each constraint to its CURRENT definition (must stay in sync with
  // prisma/post-push.sql + src/test/globalSetup.ts) — re-adding a stale
  // definition clobbers the constraint for every test file that runs after
  // this one. 034-memory-class-access re-keyed ownership onto class and
  // relaxed the app_id / agent requirements.
  await pgClient.query(`
    ALTER TABLE memories ADD CONSTRAINT chk_personal_visibility_user
      CHECK ((class IN ('personal', 'private')) = (user_id IS NOT NULL))
  `);
  await pgClient.query(`
    ALTER TABLE memories
      ADD CONSTRAINT chk_memory_class_app_id
      CHECK (
        (class = 'app' AND app_id IS NOT NULL AND install_of_agent_id IS NULL)
        OR (class = 'system' AND app_id IS NULL AND install_of_agent_id IS NULL)
        OR (class = 'system' AND app_id IS NOT NULL AND install_of_agent_id IS NOT NULL)
        OR (class IN ('knowledge', 'group', 'personal', 'private') AND install_of_agent_id IS NULL)
      )
  `);
  await pgClient.end();
});

async function runBackfillSql() {
  // The 005 migration's UPDATE statements verbatim — see
  // prisma/migrations/<timestamp>_agent_subscription/migration.sql.
  //
  // 008-agent-installation: 005's reclassification to 'personal' violates the
  // chk_memory_class_app_id constraint that 008 adds (no app_id populated by
  // 005). The constraint is dropped at the start of each test (beforeEach);
  // tests are responsible for completing the 008 app_id backfill before
  // re-adding the constraint (afterEach).
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
       visibility = NULL
     WHERE m.class = 'personal'
  `);
  await pgClient.query(`
    UPDATE memories
       SET class = 'knowledge', visibility = 'ORGANIZATION'
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
    expect(persAfter.visibility).toBe('ORGANIZATION');
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
    // 008: the eventual app_id pivot needs an App; seed one and attribute the
    // session through it so the 005 personal-class classification + the 008
    // app_id backfill (run inline below before re-adding the chk constraint)
    // both succeed.
    const app = await db.app.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:bf-app`,
        name: 'bf-app',
        appAgents: { create: { agentId: agent.id } },
      },
    });
    const personalMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:pm`, name: 'pm',
        class: 'knowledge', userMemoryOfAgentId: agent.id,
      },
    });
    await db.session.create({
      data: {
        id: generateId(), type: 'CHATBOT', memoryId: personalMemory.id, userId: user.id, appId: app.id,
      },
    });

    await pgClient.query(`UPDATE memories SET class = NULL WHERE id = $1`, [personalMemory.id]);
    await runBackfillSql();
    // Simulate the 008 app_id backfill that runs after the 005 reclassify:
    // populate app_id for personal-class memories from the most recent session
    // of (user_id, agent) that has a non-null app_id. (The actual production
    // 008 migration does this for all rows; here we apply it just to the test row.)
    await pgClient.query(
      `UPDATE memories SET app_id = $1 WHERE id = $2`,
      [app.id, personalMemory.id],
    );

    const after = await db.memory.findUniqueOrThrow({ where: { id: personalMemory.id } });
    expect(after.class).toBe('personal');
    expect(after.visibility).toBeNull();
    expect(after.userId).toBe(user.id);
  });
});
