/**
 * #4334 (part of #434 Slice C): the six partial indexes the baseline migration creates must also exist on a
 * database built by `db push` + post-push.sql (every dev and test database), with the migration's exact predicates.
 * Without `apps_urn_active_uniq` a test could create two live Apps with one handle while production refuses it
 * (cor:dmo:050:02: a handle names at most one App that is not uninstalled).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';

/** index name -> [table, unique, WHERE clause as pg_indexes prints it]; the definition is read back from pg_indexes. */
const SIX: Record<string, [string, boolean, string]> = {
  agents_urn_migration_pending_idx: ['agents', false, '((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL))'],
  apps_urn_migration_pending_idx: ['apps', false, '((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL))'],
  memories_urn_migration_pending_idx: ['memories', false, '((urn_normalized_at IS NULL) AND (urn_migration_failed_reason IS NULL))'],
  apps_urn_active_uniq: ['apps', true, '(uninstalled_at IS NULL)'],
  assets_staged_uploaded_at_idx: ['assets', false, '(memory_id IS NULL)'],
  assets_uploaded_by_staged_idx: ['assets', false, '(memory_id IS NULL)'],
};

let org: { id: string; urn: string };
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Acme', urn: 'acme' } });
});

const newApp = (urn: string, extra: Record<string, unknown> = {}) =>
  db.app.create({ data: { id: generateId(), organizationId: org.id, name: generateId().slice(0, 8), urn, ...extra } });

describe('#4334 migration-created partial indexes exist after push + post-push', () => {
  it('all six exist with the migration\'s table, uniqueness and exact predicate', async () => {
    const rows = await db.$queryRaw<{ indexname: string; tablename: string; indexdef: string }[]>`
      SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY(${Object.keys(SIX)})`;
    expect(rows.map(r => r.indexname).sort()).toEqual(Object.keys(SIX).sort());
    for (const r of rows) {
      const [table, unique, predicate] = SIX[r.indexname]!;
      expect(r.tablename).toBe(table);
      expect(/CREATE UNIQUE INDEX/.test(r.indexdef)).toBe(unique);
      expect(r.indexdef.endsWith(` WHERE ${predicate}`)).toBe(true);
    }
  });

  it('a second LIVE App with the same handle is refused', async () => {
    await newApp('acme:dup');
    await expect(newApp('acme:dup')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('an uninstalled App keeps its handle as history, and the handle re-registers (the partial predicate)', async () => {
    const first = await newApp('acme:again');
    await db.app.update({ where: { id: first.id }, data: { uninstalledAt: new Date() } });
    const second = await newApp('acme:again');
    expect(second.id).not.toBe(first.id);
    // Two uninstalled rows may also share the handle: the predicate excludes both from the index.
    await db.app.update({ where: { id: second.id }, data: { uninstalledAt: new Date() } });
    await expect(newApp('acme:again')).resolves.toBeTruthy();
  });
});
