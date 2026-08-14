/**
 * Migration test for #974 — persona scoping (20260814120000_agent_team_persona_scoping).
 *
 * The migration does three things a unit test can't see: it BACKFILLS
 * `Agent.teamAppId` from the roster join, and it GUARDS the two assumptions the
 * new rules rest on — that no existing agent or App slug already contains a `.`
 * (cor:urn:010:03), and that no persona is left team-less after the backfill
 * (cor:agt:020:01). A guard that doesn't fire is worthless, so each one is
 * exercised against a fixture that should trip it.
 *
 * Approach follows agent-subscription-backfill.test.ts: drop the invariants the
 * migration installs, build a pre-migration fixture, replay the migration's SQL
 * verbatim, then restore the invariants for the files that run after this one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';

// Prefer the per-worker DATABASE_URL (set by perWorkerDb.ts in parallel mode)
// so the raw pg client and Prisma target the SAME database.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://holger@localhost:5432/hadron_test';

let pgClient: Client;

beforeEach(async () => {
  await cleanDb(db);
  pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  // Pre-migration state: no team-boundness CHECK and no team-scoped unique, so
  // a persona row can be created with team_app_id NULL.
  await pgClient.query('ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_agent_persona_team_app');
  await pgClient.query('DROP INDEX IF EXISTS agents_team_persona_name_uniq');
});

afterEach(async () => {
  // Restore the CURRENT definitions (must stay in sync with
  // prisma/post-push.sql + src/test/globalSetup.ts). Any leftover team-less
  // persona would block the CHECK for every later test file.
  await pgClient.query('UPDATE agents SET persona_name = NULL WHERE team_app_id IS NULL');
  await pgClient.query(`
    ALTER TABLE agents ADD CONSTRAINT chk_agent_persona_team_app
      CHECK (persona_name IS NULL OR team_app_id IS NOT NULL)
  `);
  await pgClient.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_team_persona_name_uniq
      ON agents (team_app_id, lower(persona_name))
      WHERE persona_name IS NOT NULL
  `);
  await pgClient.end();
});

/** The migration's dot guard, verbatim (cor:urn:010:03). */
const DOT_GUARD = `
DO $$
DECLARE
  offending TEXT;
BEGIN
  SELECT string_agg(urn, ', ') INTO offending
    FROM agents WHERE substr(urn, position(':' IN urn) + 1) LIKE '%.%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:urn:010:03 guard: agent slug(s) already contain "." — the dot is reserved for server-derived persona slugs. Rename before migrating: %', offending;
  END IF;
  SELECT string_agg(urn, ', ') INTO offending
    FROM apps WHERE substr(urn, position(':' IN urn) + 1) LIKE '%.%';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:urn:010:03 guard: App slug(s) already contain "." — the dot is reserved for server-derived persona slugs. Rename before migrating: %', offending;
  END IF;
END $$;`;

/** The migration's backfill, verbatim. */
const BACKFILL = `
UPDATE "agents" a
   SET "team_app_id" = (
     SELECT aa."app_id" FROM "app_agents" aa
      WHERE aa."agent_id" = a."id"
      ORDER BY aa."created_at" ASC
      LIMIT 1
   )
 WHERE a."persona_name" IS NOT NULL;`;

/** The migration's orphan guard, verbatim (cor:agt:020:01). */
const ORPHAN_GUARD = `
DO $$
DECLARE
  orphans TEXT;
BEGIN
  SELECT string_agg(urn, ', ') INTO orphans
    FROM agents WHERE persona_name IS NOT NULL AND team_app_id IS NULL;
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION
      'cor:agt:020:01 backfill: persona agent(s) belong to no App, so their team App cannot be derived. Install them into their team App, or clear their persona fields, then re-run: %', orphans;
  END IF;
END $$;`;

let org: { id: string; urn: string };

/** A pre-migration persona row: persona columns set, team_app_id still NULL. */
async function createPersona(slug: string, personaName: string) {
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:${slug}`,
      name: personaName,
      personaName,
      personaRole: 'backend-engineer',
    },
  });
  await pgClient.query('UPDATE agents SET team_app_id = NULL WHERE id = $1', [agent.id]);
  return agent;
}

async function createApp(slug: string) {
  return db.app.create({
    data: { id: generateId(), organizationId: org.id, name: slug, urn: `${org.urn}:${slug}` },
  });
}

beforeEach(async () => {
  org = await db.organization.create({
    data: { id: generateId(), name: 'persona-mig', urn: `persona-mig-${generateId()}.com` },
  });
});

describe('#974 migration — teamAppId backfill', () => {
  it('binds each persona to the App it is installed in', async () => {
    const engApp = await createApp('eng-team');
    const dataApp = await createApp('data-team');
    const iris = await createPersona('iris', 'Iris');
    const ada = await createPersona('ada', 'Ada');
    await db.appAgent.create({ data: { appId: engApp.id, agentId: iris.id } });
    await db.appAgent.create({ data: { appId: dataApp.id, agentId: ada.id } });

    await pgClient.query(BACKFILL);
    await pgClient.query(ORPHAN_GUARD);

    const rows = await db.agent.findMany({
      where: { id: { in: [iris.id, ada.id] } },
      select: { id: true, teamAppId: true },
    });
    expect(rows.find((r) => r.id === iris.id)?.teamAppId).toBe(engApp.id);
    expect(rows.find((r) => r.id === ada.id)?.teamAppId).toBe(dataApp.id);
  });

  it('the OLDEST roster join wins when a persona was installed twice', async () => {
    const first = await createApp('eng-team');
    const second = await createApp('data-team');
    const iris = await createPersona('iris', 'Iris');
    await db.appAgent.create({
      data: { appId: second.id, agentId: iris.id, createdAt: new Date('2026-08-10T00:00:00Z') },
    });
    await db.appAgent.create({
      data: { appId: first.id, agentId: iris.id, createdAt: new Date('2026-08-01T00:00:00Z') },
    });

    await pgClient.query(BACKFILL);

    const row = await db.agent.findUniqueOrThrow({ where: { id: iris.id } });
    expect(row.teamAppId).toBe(first.id);
  });

  it('leaves non-persona agents unbound', async () => {
    const app = await createApp('eng-team');
    const plain = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:plain`, name: 'Plain' },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: plain.id } });

    await pgClient.query(BACKFILL);

    const row = await db.agent.findUniqueOrThrow({ where: { id: plain.id } });
    expect(row.teamAppId).toBeNull();
  });

  it('the orphan guard FIRES for a persona that belongs to no App', async () => {
    await createPersona('stray', 'Stray');
    await pgClient.query(BACKFILL);
    await expect(pgClient.query(ORPHAN_GUARD)).rejects.toThrow(/cor:agt:020:01 backfill/);
  });
});

describe('#974 migration — the dot guard (cor:urn:010:03)', () => {
  it('passes on a clean population — a dotted org ROOT is not a dotted slug', async () => {
    // org.urn is a dotted domain by policy; the guard must look only at the
    // slug, i.e. everything after the FIRST colon.
    await createApp('eng-team');
    await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:plain`, name: 'Plain' },
    });
    await expect(pgClient.query(DOT_GUARD)).resolves.toBeTruthy();
  });

  it('FIRES on a pre-existing dotted agent slug', async () => {
    await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:acme.bot`, name: 'Acme Bot' },
    });
    await expect(pgClient.query(DOT_GUARD)).rejects.toThrow(/cor:urn:010:03 guard: agent slug/);
  });

  it('FIRES on a pre-existing dotted App slug', async () => {
    await createApp('eng.team');
    await expect(pgClient.query(DOT_GUARD)).rejects.toThrow(/cor:urn:010:03 guard: App slug/);
  });
});
