/**
 * #4001 (S6), cor:sec:060:03 / cor:acl:140:02: the auto-delete mark is a grant term and needs a finite end.
 * Database-only red preparation while S3 #3998 is unmerged. These exercise real grant constraints without importing
 * absent secret/client modules. The two secret action rows below are isolated test FK targets, never production seeds
 * or byte-review evidence. When S3 supplies the real registered actions, leave their definitions untouched.
 * Runtime admission, reveal/rollback and sweep pins must be added against S3's merged interfaces before S6 is ready.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { dbNowPlus, dropTestActions, insertGrant, seedWorld, TEST_ACTION, type World } from './grantFixtures3668.js';

const ACTIONS = ['secret.reveal', 'secret.use'] as const;
const createdActions = new Set<string>();
let w: World;

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  for (const action of ACTIONS) {
    const parameters = [
      { name: 'secret', type: 'secret-ref', refusesWildcard: true },
      { name: 'auto-delete', type: 'secret-mark', refusesWildcard: true },
      ...(action === 'secret.use' ? [
        { name: 'binding-prefix', type: 'https-prefix', refusesWildcard: true },
        { name: 'binding-header', type: 'header-name', refusesWildcard: true },
      ] : []),
    ];
    const inserted = await db.$queryRaw<Array<{ name: string }>>`
      INSERT INTO actions (name, source, parameters, enforcement, issuer_rule, summary_template, created_at, updated_at)
      VALUES (${action}, 'PLATFORM', ${JSON.stringify(parameters)}::jsonb, 'SERVER', 'TEST_ONLY', 'S6 database fixture',
              clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')
      ON CONFLICT (name) DO NOTHING RETURNING name`;
    if (inserted.length) createdActions.add(action);
  }
});

afterAll(async () => {
  await cleanDb(db);
  for (const action of createdActions) await db.action.delete({ where: { name: action } });
  await dropTestActions();
});

function values(action: string, mark: 'keep' | 'delete') {
  return {
    secret: generateId(), 'auto-delete': mark,
    ...(action === 'secret.use' ? { 'binding-prefix': 'https://example.test/api/', 'binding-header': 'Authorization' } : {}),
  };
}

describe.each(ACTIONS)('#4001 finite-end database invariant for %s', (action) => {
  it('refuses delete without expiry or budget, without inserting a grant', async () => {
    const count = await db.grant.count({ where: { appId: w.appId } });
    // SQLSTATE matters: an absent action/holder or a fixture error is not the required CHECK refusal.
    await expect(insertGrant(w, { action, action_values: values(action, 'delete') }))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    expect(await db.grant.count({ where: { appId: w.appId } })).toBe(count);
  });

  it('allows keep without expiry or budget (negative control)', async () => {
    await expect(insertGrant(w, { action, action_values: values(action, 'keep') })).resolves.toBeTruthy();
  });

  it('allows delete with expiry alone', async () => {
    await expect(insertGrant(w, { action, action_values: values(action, 'delete'), expires_at: dbNowPlus('1 hour') }))
      .resolves.toBeTruthy();
  });

  it('allows delete with budget alone', async () => {
    await expect(insertGrant(w, { action, action_values: values(action, 'delete'), max_uses: 1 })).resolves.toBeTruthy();
  });

  it('allows delete with both limits', async () => {
    await expect(insertGrant(w, { action, action_values: values(action, 'delete'), max_uses: 1, expires_at: dbNowPlus('1 hour') }))
      .resolves.toBeTruthy();
  });

  it('cannot gain the signed delete term after insertion (existing guard control)', async () => {
    const initial = values(action, 'keep');
    const id = await insertGrant(w, { action, action_values: initial, max_uses: 1 });
    await expect(db.$executeRaw`UPDATE grants SET action_values = ${JSON.stringify({ ...initial, 'auto-delete': 'delete' })}::jsonb WHERE id = ${id}`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id }, select: { values: true } })).values).toEqual(initial);
  });
});

it('#4001 does not impose secret auto-delete semantics on unrelated actions', async () => {
  await expect(insertGrant(w, { action: TEST_ACTION, action_values: { 'auto-delete': 'delete' } })).resolves.toBeTruthy();
});
