/**
 * 008-agent-installation — migration smoke tests (User Story 4).
 *
 * Verifies the migration is correct under the four documented shapes:
 *   - single-AppAgent App     (the common case)
 *   - multi-AppAgent fan-out  (the rare case the spec calls out)
 *   - orphan App              (zero AppAgent rows)
 *   - DEVELOP-role logging    (R-10 dropped capability)
 *
 * Test mechanics: the migration has already run against `hadron_test` (the
 * `app_agents` table is gone). To exercise the migration logic, each test
 * recreates the dropped `app_agents` shape, seeds it, runs the relevant
 * migration SQL chunks (verbatim from
 * `prisma/migrations/20260502120000_two_layer_agent_app/migration.sql`),
 * and asserts the post-state. The chk_memory_class_app_id constraint is
 * temporarily dropped during these tests because the migration's backfill
 * is supposed to populate `app_id` BEFORE the constraint is added (see the
 * step ordering in migration.sql); recreating that ordering inside an
 * already-migrated DB requires the same staging.
 *
 * Verifies SC-001 (row-count math), SC-002 (auth replay), and the per-shape
 * acceptance scenarios from spec.md User Story 4.
 *
 * @see specs/008-agent-installation/contracts/migration-sql.md
 * @see specs/008-agent-installation/spec.md (User Story 4)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { createHash, randomBytes } from 'crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { getPrimaryAgentId } from '../../lib/appAgent.js';
import { generateId } from '../../lib/id.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://holger@localhost:5432/hadron_test';
const APP_KEY_PREFIX = 'hdr_app_';

let pgClient: Client;

// ─────────────────────────────────────────────────────────────────────────
// Migration SQL chunks — verbatim copies of the relevant blocks from
// prisma/migrations/20260502120000_two_layer_agent_app/migration.sql. The
// authoritative SQL is the file under prisma/migrations/; these are kept
// in sync manually. If the migration changes, this test file must too.
// ─────────────────────────────────────────────────────────────────────────

/** Step 3a: single-AppAgent fold. */
const SQL_FOLD_SINGLE = `
  UPDATE "apps" a
     SET "agent_id"      = aa."agent_id",
         "training_mode" = aa."training_mode"
    FROM "app_agents" aa
   WHERE aa."app_id" = a."id"
     AND (SELECT COUNT(*) FROM "app_agents" WHERE "app_id" = a."id") = 1
`;

/** Step 3b: fan-out for Apps with N>1 AppAgent rows. */
const SQL_FAN_OUT = `
  DO $$
  DECLARE
    app_record RECORD;
    agent_record RECORD;
    new_app_id TEXT;
    is_first BOOLEAN;
  BEGIN
    FOR app_record IN
      SELECT a."id", a."urn"
        FROM "apps" a
       WHERE (SELECT COUNT(*) FROM "app_agents" WHERE "app_id" = a."id") > 1
    LOOP
      is_first := TRUE;
      FOR agent_record IN
        SELECT "agent_id", "training_mode"
          FROM "app_agents"
         WHERE "app_id" = app_record."id"
         ORDER BY "created_at" ASC, "agent_id" ASC
      LOOP
        IF is_first THEN
          UPDATE "apps"
             SET "agent_id"      = agent_record."agent_id",
                 "training_mode" = agent_record."training_mode"
           WHERE "id" = app_record."id";
          is_first := FALSE;
        ELSE
          new_app_id := gen_random_uuid()::TEXT;

          INSERT INTO "apps" (
            "id", "organization_id", "urn", "name", "app_type", "role",
            "description", "system_prompt", "agent_tools",
            "ai_provider", "ai_model", "ai_api_key_encrypted",
            "expires_at", "create_user_permission", "identify_user_method",
            "session_timeout_seconds", "anonymous_ttl_days",
            "agent_id", "training_mode", "surfaces",
            "created_at", "created_by"
          )
          SELECT
            new_app_id, "organization_id", "urn" || ':fanned-' || agent_record."agent_id",
            "name" || ' (' || agent_record."agent_id" || ')',
            "app_type", "role",
            "description", "system_prompt", "agent_tools",
            "ai_provider", "ai_model", "ai_api_key_encrypted",
            "expires_at", "create_user_permission", "identify_user_method",
            "session_timeout_seconds", "anonymous_ttl_days",
            agent_record."agent_id", agent_record."training_mode", "surfaces",
            NOW(), 'migration:008-agent-installation'
            FROM "apps" WHERE "id" = app_record."id";

          INSERT INTO "app_keys" (
            "id", "app_id", "key_hash", "key_preview", "label",
            "last_used_at", "revoked_at",
            "created_at", "created_by"
          )
          SELECT
            gen_random_uuid()::TEXT, new_app_id,
            "key_hash" || ':fanned-' || agent_record."agent_id",
            "key_preview", "label",
            "last_used_at", "revoked_at",
            NOW(), 'migration:008-agent-installation'
            FROM "app_keys" WHERE "app_id" = app_record."id";
        END IF;
      END LOOP;
    END LOOP;
  END $$
`;

/** Step 3d: log DEVELOP rows + write app_log entries (per T021). */
const SQL_LOG_DEVELOP = `
  DO $$
  DECLARE
    develop_record RECORD;
  BEGIN
    FOR develop_record IN
      SELECT "app_id", "agent_id" FROM "app_agents" WHERE "role" = 'DEVELOP'
    LOOP
      RAISE NOTICE 'AppAgent.role=DEVELOP migrated: app_id=% agent_id=% (DEVELOP-from-App is no longer supported; use the Agent-ownership surface to edit Agent definitions)',
        develop_record."app_id", develop_record."agent_id";

      INSERT INTO "app_log" (
        "id", "app_id", "level", "message", "detail",
        "created_at", "created_by"
      )
      VALUES (
        gen_random_uuid()::TEXT,
        develop_record."app_id",
        'WARN',
        'DEVELOP-from-App is no longer supported. To edit this Agent''s design, open the Agent in its owning org''s ownership surface.',
        jsonb_build_object(
          'source', 'migration:008-agent-installation',
          'reason', 'AppAgent.role=DEVELOP dropped per spec 008 R-10',
          'agentId', develop_record."agent_id"
        ),
        NOW(),
        'migration:008-agent-installation'
      );
    END LOOP;
  END $$
`;

/** Step 4a: Memory.app_id backfill from Session attribution. */
const SQL_MEMORY_APP_ID_BACKFILL = `
  UPDATE "memories" m
     SET "app_id" = (
           SELECT s."app_id"
             FROM "sessions" s
            WHERE s."user_id"  = m."user_id"
              AND s."app_id"   IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM "apps" a
                 WHERE a."id" = s."app_id"
                   AND a."agent_id" = m."user_memory_of_agent_id"
              )
            ORDER BY s."started_at" DESC
            LIMIT 1
         )
   WHERE m."class" = 'personal'
     AND m."app_id" IS NULL
`;

/** Step 4b: downgrade unattributed personal memories to knowledge. */
const SQL_DOWNGRADE_ORPHAN_PERSONAL = `
  UPDATE "memories"
     SET "class" = 'knowledge', "user_id" = NULL, "visibility" = 'PRIVATE'
   WHERE "class" = 'personal' AND "app_id" IS NULL
`;

/** Recreate the dropped `app_agents` table so each test can seed pre-migration shape. */
async function recreateAppAgents() {
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS "app_agents" (
      "app_id" TEXT NOT NULL,
      "agent_id" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'OPERATE',
      "training_mode" BOOLEAN NOT NULL DEFAULT FALSE,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "created_by" TEXT,
      "updated_at" TIMESTAMPTZ,
      "updated_by" TEXT,
      "deleted_at" TIMESTAMPTZ,
      "deleted_by" TEXT,
      PRIMARY KEY ("app_id", "agent_id"),
      CONSTRAINT "app_agents_app_id_fkey"
        FOREIGN KEY ("app_id") REFERENCES "apps" ("id") ON DELETE CASCADE,
      CONSTRAINT "app_agents_agent_id_fkey"
        FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE
    )
  `);
}

async function dropAppAgents() {
  await pgClient.query(`DROP TABLE IF EXISTS "app_agents" CASCADE`);
}

// ─────────────────────────────────────────────────────────────────────────
// Suite setup — drop chk_memory_class_app_id so backfill can run mid-test
// in the same staged-then-asserted order the production migration uses
// (the constraint is added AFTER backfill in migration.sql step 5). We
// re-add it in afterAll so subsequent test files see the constraint.
// ─────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pgClient = new Client({ connectionString: DATABASE_URL });
  await pgClient.connect();
  await pgClient.query(`ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_class_app_id`);
});

afterAll(async () => {
  await dropAppAgents();
  // Clean any rows the tests left in app/personal class with NULL app_id —
  // those are mid-backfill states that shouldn't persist past this file.
  await pgClient.query(`
    UPDATE memories SET class = 'knowledge', user_id = NULL, visibility = 'PRIVATE'
    WHERE class IN ('app', 'personal') AND app_id IS NULL
  `);
  await pgClient.query(`
    ALTER TABLE memories
      ADD CONSTRAINT chk_memory_class_app_id
      CHECK (
        (class IN ('app', 'personal') AND app_id IS NOT NULL)
        OR (class IN ('system', 'knowledge') AND app_id IS NULL)
      )
  `);
  await pgClient.end();
});

beforeEach(async () => {
  await cleanDb(db);
  // cleanDb drops everything via Prisma — including app_agents rows in
  // theory. But Prisma doesn't know about app_agents (we recreated it after
  // schema generation), so cleanDb skips it. Drop + recreate the table
  // explicitly so each test starts fresh.
  await dropAppAgents();
  await recreateAppAgents();
});

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

interface SeedFixture {
  orgId: string;
  agents: { id: string; urn: string }[];
  apps: {
    id: string;
    urn: string;
    appAgents: { agentId: string; role: 'OPERATE' | 'DEVELOP'; trainingMode?: boolean }[];
  }[];
}

async function seedFixture(spec: {
  orgUrn: string;
  agents: number;
  appShapes: Array<{
    appAgentRoles?: Array<'OPERATE' | 'DEVELOP'>;
    trainingModes?: boolean[];
  }>;
  appsWithKeys?: number; // how many apps get a single AppKey each
}): Promise<SeedFixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: spec.orgUrn, urn: spec.orgUrn },
  });
  const agents: SeedFixture['agents'] = [];
  for (let i = 0; i < spec.agents; i++) {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:agent-${i}`,
        name: `agent-${i}`,
      },
    });
    agents.push({ id: agent.id, urn: agent.urn });
  }
  const apps: SeedFixture['apps'] = [];
  for (let i = 0; i < spec.appShapes.length; i++) {
    const shape = spec.appShapes[i];
    const app = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:app-${i}`,
        name: `app-${i}`,
      },
    });
    if ((spec.appsWithKeys ?? 0) > i) {
      const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      await db.appKey.create({
        data: {
          id: generateId(),
          appId: app.id,
          keyHash,
          keyPreview: `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`,
        },
      });
    }
    const appAgents: SeedFixture['apps'][0]['appAgents'] = [];
    const roles = shape.appAgentRoles ?? [];
    for (let j = 0; j < roles.length; j++) {
      const agentId = agents[j % agents.length].id;
      const role = roles[j];
      const trainingMode = shape.trainingModes?.[j] ?? false;
      // Insert directly — `app_agents` is dropped from the Prisma model.
      // created_at incremented per row so the (created_at, agent_id) ordering
      // inside the migration's fan-out is deterministic for asserts.
      await pgClient.query(
        `INSERT INTO "app_agents" ("app_id", "agent_id", "role", "training_mode", "created_at")
         VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 millisecond'))`,
        [app.id, agentId, role, trainingMode, j],
      );
      appAgents.push({ agentId, role, trainingMode });
    }
    apps.push({ id: app.id, urn: app.urn, appAgents });
  }
  return { orgId: org.id, agents, apps };
}

async function runMigrationBackfill() {
  // The full backfill chunk-by-chunk, in the same order the production
  // migration applies them (step 3a → 3b → 3d → 4a → 4b).
  await pgClient.query(SQL_FOLD_SINGLE);
  await pgClient.query(SQL_FAN_OUT);
  await pgClient.query(SQL_LOG_DEVELOP);
  await pgClient.query(SQL_MEMORY_APP_ID_BACKFILL);
  await pgClient.query(SQL_DOWNGRADE_ORPHAN_PERSONAL);
}

// ─────────────────────────────────────────────────────────────────────────
// T022 — smoke test (row counts + URN preservation)
// ─────────────────────────────────────────────────────────────────────────

describe('T022: migration smoke (row counts + URN preservation, SC-001)', () => {
  it('preserves App count for single-AppAgent shape; +1 per fanned agent for multi', async () => {
    const fixture = await seedFixture({
      orgUrn: 'smoke-org',
      agents: 3,
      appShapes: [
        { appAgentRoles: ['OPERATE'] },                      // single
        { appAgentRoles: ['OPERATE', 'OPERATE', 'OPERATE'] }, // fan-out × 2
        { appAgentRoles: [] },                                // orphan
      ],
    });

    const beforeApps = await db.app.count();
    const beforeAgents = await db.agent.count();
    const beforeKeys = await db.appKey.count();
    expect(beforeApps).toBe(3);
    expect(beforeAgents).toBe(3);

    await runMigrationBackfill();

    const afterApps = await db.app.count();
    const afterAgents = await db.agent.count();
    const afterKeys = await db.appKey.count();

    // SC-001: post = pre + (sum of app_agents pairs > 1 per App). Here the
    // multi-AppAgent App had 3 rows → 2 fanned copies created → +2 Apps.
    expect(afterApps).toBe(beforeApps + 2);
    expect(afterAgents).toBe(beforeAgents);
    expect(afterKeys).toBe(beforeKeys); // no AppKeys seeded → fan-out produced none

    // URNs preserved on the original Apps
    for (const seeded of fixture.apps) {
      const after = await db.app.findUnique({ where: { id: seeded.id } });
      expect(after).not.toBeNull();
      expect(after!.urn).toBe(seeded.urn);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T023 — auth replay (pre-migration AppKeys still authenticate)
// ─────────────────────────────────────────────────────────────────────────

describe('T023: auth-replay (pre-migration bearer tokens still authenticate, SC-002)', () => {
  it('every pre-migration AppKey survives the single-AppAgent fold unchanged', async () => {
    // Seed 10 single-AppAgent Apps each with a fresh AppKey. Capture the raw
    // keys so we can replay the auth lookup after the migration.
    const N = 10;
    const fixture = await seedFixture({
      orgUrn: 'auth-org',
      agents: 1,
      appShapes: Array.from({ length: N }, () => ({ appAgentRoles: ['OPERATE'] as Array<'OPERATE'> })),
      appsWithKeys: N,
    });

    const preKeys = await db.appKey.findMany({ orderBy: { id: 'asc' } });
    expect(preKeys.length).toBe(N);

    await runMigrationBackfill();

    // Each pre-migration keyHash should still resolve to its parent App, with
    // App.agentId now populated. (The auth resolver looks up by keyHash; that
    // path is unchanged by the migration.)
    for (const preKey of preKeys) {
      const post = await db.appKey.findUnique({ where: { id: preKey.id } });
      expect(post).not.toBeNull();
      expect(post!.keyHash).toBe(preKey.keyHash);
      expect(post!.appId).toBe(preKey.appId);

      const app = await db.app.findUnique({ where: { id: post!.appId } });
      expect(await getPrimaryAgentId(db, app!.id)).toBe(fixture.agents[0].id);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T024 — fan-out (1 App, 3 AppAgents)
// ─────────────────────────────────────────────────────────────────────────

describe('T024: fan-out (1 App with 3 AppAgents)', () => {
  it('keeps the original App + creates 2 fanned copies; AppKeys duplicated with hash suffix', async () => {
    const fixture = await seedFixture({
      orgUrn: 'fan-org',
      agents: 3,
      appShapes: [{ appAgentRoles: ['OPERATE', 'DEVELOP', 'OPERATE'] }],
      appsWithKeys: 1,
    });
    const sourceApp = fixture.apps[0];
    const sourceKey = await db.appKey.findFirstOrThrow({ where: { appId: sourceApp.id } });

    await runMigrationBackfill();

    // Original App keeps its id + urn; agent_id set to the deterministically
    // first AppAgent (created_at, agent_id ordering in the migration).
    const originalAfter = await db.app.findUniqueOrThrow({ where: { id: sourceApp.id } });
    expect(originalAfter.urn).toBe(sourceApp.urn);
    expect(await getPrimaryAgentId(db, originalAfter.id)).toBe(sourceApp.appAgents[0].agentId);

    // Two fanned copies exist with derived URN + name.
    const fanned = await db.app.findMany({
      where: {
        organizationId: fixture.orgId,
        urn: { startsWith: `${sourceApp.urn}:fanned-` },
      },
      orderBy: { urn: 'asc' },
    });
    expect(fanned.length).toBe(2);
    const fannedAgentIds = new Set(
      await Promise.all(fanned.map((a) => getPrimaryAgentId(db, a.id))),
    );
    expect(fannedAgentIds).toEqual(
      new Set([sourceApp.appAgents[1].agentId, sourceApp.appAgents[2].agentId]),
    );
    for (const fApp of fanned) {
      // urn carries :fanned-<agent_id> suffix
      expect(fApp.urn).toMatch(/:fanned-[a-z0-9]+$/);
      // policies inherited from the source
      expect(fApp.organizationId).toBe(fixture.orgId);
      expect(fApp.createdBy).toBe('migration:008-agent-installation');
    }

    // AppKeys: 1 original + 2 fanned, each with the source key_hash plus
    // ':fanned-<agent_id>' suffix on the fanned copies.
    const allKeys = await db.appKey.findMany({});
    expect(allKeys.length).toBe(3);
    const fannedKeys = allKeys.filter((k) => k.appId !== sourceApp.id);
    expect(fannedKeys.length).toBe(2);
    for (const fk of fannedKeys) {
      expect(fk.keyHash).toMatch(new RegExp(`^${sourceKey.keyHash}:fanned-`));
    }
    // The original wire token still authenticates to the original App only —
    // the fanned copies have new (suffix-mangled) hashes that no real token
    // would match. Verified here by hash inequality.
    const originalKey = allKeys.find((k) => k.appId === sourceApp.id);
    expect(originalKey!.keyHash).toBe(sourceKey.keyHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T025 — orphan App (zero AppAgent rows)
// ─────────────────────────────────────────────────────────────────────────

describe('T025: orphan App (zero AppAgent rows)', () => {
  it('preserves the App with agent_id NULL — no fan-out, no row added', async () => {
    const fixture = await seedFixture({
      orgUrn: 'orphan-org',
      agents: 1,
      appShapes: [{ appAgentRoles: [] }],
    });
    const orphan = fixture.apps[0];
    const beforeApps = await db.app.count();

    await runMigrationBackfill();

    const after = await db.app.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(await getPrimaryAgentId(db, after.id)).toBeNull();
    expect(after.urn).toBe(orphan.urn);
    expect(await db.app.count()).toBe(beforeApps);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T026 — DEVELOP-role logging (NOTICE + app_log row, T021)
// ─────────────────────────────────────────────────────────────────────────

describe('T026: DEVELOP-role logging (T021 — NOTICE + app_log entry)', () => {
  it('writes a WARN-level app_log entry for each DEVELOP row', async () => {
    const fixture = await seedFixture({
      orgUrn: 'dev-org',
      agents: 2,
      appShapes: [
        { appAgentRoles: ['DEVELOP'] },
        { appAgentRoles: ['OPERATE'] },
      ],
    });
    const developApp = fixture.apps[0];
    const operateApp = fixture.apps[1];

    await runMigrationBackfill();

    const developLogs = await db.appLogEntry.findMany({
      where: { appId: developApp.id, level: 'WARN' },
    });
    expect(developLogs.length).toBe(1);
    const detail = developLogs[0].detail as Record<string, unknown>;
    expect(detail.source).toBe('migration:008-agent-installation');
    expect(detail.reason).toContain('DEVELOP');
    expect(detail.agentId).toBe(developApp.appAgents[0].agentId);

    // The OPERATE App gets no log entry.
    const operateLogs = await db.appLogEntry.findMany({
      where: { appId: operateApp.id, level: 'WARN' },
    });
    expect(operateLogs.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T027 — Memory.app_id backfill via Session attribution + downgrade fallback
// ─────────────────────────────────────────────────────────────────────────

describe('T027: Memory.app_id backfill (Session attribution + downgrade fallback)', () => {
  it('sets app_id from the most-recent attributing session', async () => {
    const fixture = await seedFixture({
      orgUrn: 'mem-org',
      agents: 1,
      appShapes: [{ appAgentRoles: ['OPERATE'] }],
    });
    const app = fixture.apps[0];
    const agent = fixture.agents[0];

    const user = await db.user.create({ data: { id: generateId(), githubId: 88001 } });

    // Personal memory pre-008: app_id NULL, userMemoryOfAgentId set.
    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fixture.orgId,
        urn: `${fixture.orgId}:m`,
        name: 'm',
        class: 'personal',
        visibility: 'PERSONAL',
        userId: user.id,
        userMemoryOfAgentId: agent.id,
        // app_id intentionally left NULL — the migration will backfill it
      },
    });

    // Step 3a runs first → sets App.agent_id. Then step 4a finds the App via
    // the matching session.
    await pgClient.query(SQL_FOLD_SINGLE);
    await db.session.create({
      data: {
        id: generateId(),
        type: 'CHATBOT',
        memoryId: memory.id,
        userId: user.id,
        appId: app.id,
        agentId: agent.id,
      },
    });

    await pgClient.query(SQL_MEMORY_APP_ID_BACKFILL);

    const after = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(after.appId).toBe(app.id);
    expect(after.class).toBe('personal');
  });

  it('downgrades to knowledge when no Session attributes the personal memory', async () => {
    const fixture = await seedFixture({
      orgUrn: 'orphan-mem-org',
      agents: 1,
      appShapes: [{ appAgentRoles: ['OPERATE'] }],
    });
    const agent = fixture.agents[0];
    const user = await db.user.create({ data: { id: generateId(), githubId: 88002 } });

    const memory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: fixture.orgId,
        urn: `${fixture.orgId}:orphan-m`,
        name: 'orphan-m',
        class: 'personal',
        visibility: 'PERSONAL',
        userId: user.id,
        userMemoryOfAgentId: agent.id,
        // No Session is created → backfill can't find an app, downgrade fires.
      },
    });

    await runMigrationBackfill();

    const after = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    expect(after.class).toBe('knowledge');
    expect(after.visibility).toBe('PRIVATE');
    expect(after.userId).toBeNull();
    expect(after.appId).toBeNull();
  });
});
