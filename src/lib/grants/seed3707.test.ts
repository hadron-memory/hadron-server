/**
 * #3707 S1b — the platform list carries its first two actions, `schedule.create` and `webhook.create`, written by S1a's
 * idempotent upsert. Terms are cor:acl:140:02 as ruled (0253, item 1): one parameter (the entry node), a wildcard is
 * refused, server-enforced, issued by whoever may create one in that App. Seeds ACTION rows only: no holder, no grant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { dropTestActions, seedWorld, insertGrant, grantValues } from './grantFixtures3668.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';

type Row = {
  name: string; source: string; parameters: unknown; tool: string | null; enforcement: string; issuer_rule: string;
  summary_template: string; xmin: string; updated_at: Date;
};
const seeded = () => db.$queryRawUnsafe<Row[]>(
  `SELECT name, source, parameters, tool, enforcement, issuer_rule, summary_template, xmin::text AS xmin, updated_at
     FROM actions WHERE name IN ('schedule.create', 'webhook.create') ORDER BY name`);

beforeEach(async () => { await cleanDb(db); await dropTestActions(); await db.$executeRawUnsafe(`DELETE FROM actions WHERE name IN ('schedule.create', 'webhook.create', 'bootprompt.source.edit', 'bootprompt.compile.approve', 'secret.reveal')`); });

describe('#3707: the shipped platform list', () => {
  it('names exactly the five seeded actions, and nothing else (#3823 added the two boot-prompt grants)', () => {
    expect(PLATFORM_ACTIONS.map((a) => a.name).sort()).toEqual(['bootprompt.compile.approve', 'bootprompt.source.edit', 'schedule.create', 'secret.reveal', 'webhook.create']);
  });

  it('each declares the ruled terms: entry-node parameter that refuses a wildcard, server-enforced, platform source, no tool', () => {
    const entry = PLATFORM_ACTIONS.filter((a) => a.name === 'schedule.create' || a.name === 'webhook.create');
    expect(entry).toHaveLength(2);
    for (const a of entry) {
      expect(a.parameters, a.name).toEqual([{ name: 'entryNode', type: 'node-ref', refusesWildcard: true }]);
      expect(a.enforcement, a.name).toBe('SERVER');
      expect(a.source, a.name).toBe('PLATFORM');
      expect(a.tool, a.name).toBeNull();
      expect(a.summaryTemplate.trim().length, a.name).toBeGreaterThan(0);
    }
  });

  it('the issuer rules are closed keys, one per action', () => {
    expect(Object.fromEntries(PLATFORM_ACTIONS.map((a) => [a.name, a.issuerRule]))).toEqual({
      'schedule.create': 'APP_SCHEDULE_ADMIN', 'webhook.create': 'APP_WEBHOOK_ADMIN',
      'bootprompt.source.edit': 'APP_MANAGER', 'bootprompt.compile.approve': 'APP_MANAGER', 'secret.reveal': 'SECRET_READ_CLIENT',
    });
  });
});

describe('#3707: the deploy upsert writes both rows, and a second run changes nothing', () => {
  it('a first upsert inserts both rows with the declared terms', async () => {
    expect(await upsertPlatformActions(db)).toEqual({ inserted: 5, updated: 0, unchanged: 0 });
    const rows = await seeded();
    expect(rows.map((r) => r.name)).toEqual(['schedule.create', 'webhook.create']);
    for (const r of rows) {
      expect(r.parameters).toEqual([{ name: 'entryNode', type: 'node-ref', refusesWildcard: true }]);
      expect(r).toMatchObject({ source: 'PLATFORM', tool: null, enforcement: 'SERVER' });
    }
    expect(rows.map((r) => r.issuer_rule)).toEqual(['APP_SCHEDULE_ADMIN', 'APP_WEBHOOK_ADMIN']);
  });

  it('a second upsert is a no-op: same tuple versions, same updated_at', async () => {
    await upsertPlatformActions(db);
    const first = await seeded();
    await new Promise((r) => setTimeout(r, 25));
    expect(await upsertPlatformActions(db)).toEqual({ inserted: 0, updated: 0, unchanged: 5 });
    expect(await seeded()).toEqual(first);
  });

  it('a drifted row is put back by the next upsert (the list in code is the source)', async () => {
    await upsertPlatformActions(db);
    await db.$executeRawUnsafe(`UPDATE actions SET enforcement = 'RECORDED_ONLY' WHERE name = 'schedule.create'`);
    expect(await upsertPlatformActions(db)).toEqual({ inserted: 0, updated: 1, unchanged: 4 });
    expect((await seeded())[0].enforcement).toBe('SERVER');
  });
});

describe('#3707: an unknown action still records nothing usable (S1a unchanged)', () => {
  it('a grant naming an action that is not a row is refused by the database, even after the seed', async () => {
    await upsertPlatformActions(db);
    const w = await seedWorld();
    await expect(insertGrant(w, { action: 'schedule.creat' })).rejects.toThrow(/23503|foreign key|grants_action/i);
    // control: a seeded action is a row a grant may name.
    await expect(insertGrant(w, { ...grantValues(w, { action: 'schedule.create' }) })).resolves.toBeTruthy();
  });
});
