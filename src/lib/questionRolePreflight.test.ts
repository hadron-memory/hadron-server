/**
 * #4425 S1 — the question-role preflight guard
 * (prisma/migrations/20261118010000_question_role_preflight/migration.sql).
 *
 * The decision→question rename makes `question` / `question.*` governed roles in code. A node that
 * already carries such a role — written while the platform treated the string as inert — would be
 * captured at deploy: uneditable and undeletable through the generic doors, no exit. The guard
 * refuses that deployment, REPORTING what it found (SQLSTATE 'HDPRF', the #3770 refusing-preflight
 * convention: alarm + serve-the-existing-schema, re-attempted each boot until repaired).
 *
 * The #4425 contract's Old rows are the negative space of this guard: rows carrying `decision` or
 * `decision.log` become ordinary writer-editable nodes BY CONTRACT ("Rows that already have role
 * `decision` or `decision.log` are left as they are", Acceptance 4), so they must NEVER refuse —
 * only the reverse collision does (Bruce #116933/#117220/#116976; LOCAL F1 and §10 P2-1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../prisma/migrations/20261118010000_question_role_preflight/migration.sql', import.meta.url)),
  'utf8',
);

// A raw pg connection in simple-query mode: the migration is multi-statement, and Prisma's
// prepared statements take exactly one (the chat-seq preflight test's harness).
const runMigration = async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(MIGRATION);
  } finally {
    await client.end();
  }
};

let memoryId: string;

const seedRole = (role: string, loc: string, extra: { deletedAt?: Date } = {}) =>
  db.node.create({
    data: { id: generateId(), memoryId, loc, name: `node ${loc}`, role, nodeType: 'info', ...extra },
    select: { id: true },
  });

const attempt = async (): Promise<{ refused: boolean; error?: Error & { code?: string; detail?: string } }> => {
  try {
    await runMigration();
    return { refused: false };
  } catch (error) {
    return { refused: true, error: error as Error & { code?: string; detail?: string } };
  }
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Preflight Org', urn: 'qpreflight.example' } });
  const memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'shared', urn: 'qpreflight.example:shared', class: 'knowledge' },
    select: { id: true },
  });
  memoryId = memory.id;
});

describe('#4425 — the question-role preflight guard', () => {
  it('refuses a live question-role node with HDPRF, reporting it, and repairs nothing', async () => {
    const offender = await seedRole('question', 'squat:one');
    const { refused, error } = await attempt();
    expect(refused, 'expected the preflight to refuse').toBe(true);
    expect(error!.message).toMatch(/question role preflight/i);
    // #3770 boot protocol: the refusal's SQLSTATE is the classifier's marker (alarm + serve).
    expect(error!.code).toBe('HDPRF');
    expect(String(error!.detail)).toContain(`${memoryId} / squat:one / question / live`);
    // Never renames, deletes, exempts or chooses a repair.
    expect(await db.node.findUniqueOrThrow({ where: { id: offender.id } })).toMatchObject({ role: 'question', deletedAt: null });
  });

  it('refuses a soft-deleted question.* node too — a revived row would be captured all the same', async () => {
    await seedRole('question.log', 'gone:sub', { deletedAt: new Date() });
    const { refused, error } = await attempt();
    expect(refused).toBe(true);
    expect(error!.code).toBe('HDPRF');
    expect(String(error!.detail)).toContain(`${memoryId} / gone:sub / question.log / soft-deleted`);
  });

  it('reports the count and up to the first 10 offenders in (memory, loc) order', async () => {
    await seedRole('question', 'b');
    await seedRole('question.decider', 'a');
    const { refused, error } = await attempt();
    expect(refused).toBe(true);
    expect(error!.message).toMatch(/2 node\(s\)/);
    const detail = String(error!.detail);
    expect(detail.indexOf('/ a /')).toBeLessThan(detail.indexOf('/ b /'));
  });

  it("passes the #4425 contract's Old rows: decision and decision.log nodes never refuse", async () => {
    await seedRole('decision', 'old:DA');
    await seedRole('decision.log', 'old');
    await expect(runMigration()).resolves.toBeUndefined();
    expect(await db.node.count({ where: { memoryId } })).toBe(2);
  });

  it('passes an empty database (the clean deploy)', async () => {
    await expect(runMigration()).resolves.toBeUndefined();
  });
});
