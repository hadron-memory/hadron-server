/**
 * #4001 (S6), cor:sec:060:03 / cor:acl:140:02: the auto-delete mark is a grant term and needs a finite end.
 * Database constraint coverage, using real S3 action definitions where present and an isolated fixture for future secret.use.
 * Runtime admission, signed reveal and sweep coverage lives in resolvers.secretAutoDelete4001.test.ts.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { dbNowPlus, dropTestActions, insertGrant, seedWorld, TEST_ACTION, type World } from './grantFixtures3668.js';

const ACTIONS = ['secret.reveal', 'secret.use'] as const;
// 23514 is also what the grants_guard append-only trigger raises, so a pin that matches the code alone can pass on
// the wrong guard. The trigger's own message is what these pins must see.
const AUTO_DELETE_REFUSAL = { code: 'P2010', meta: { code: '23514', message: expect.stringContaining('an auto-delete grant needs an expiry or use budget') } };
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

// The trigger has three branches (insert/changed terms, activation, unchanged-terms lifecycle update). The
// tests above reach the insert branch and the action_values change; these pin the other two against the raw
// database, so removing either branch (a mutant) fails here and not only in the resolver suites.
// Historical rows predate the guard, so the fixture drops it for one transaction, exactly as the S6 migration found them.
async function historicalUnboundedMark(action: string): Promise<string> {
  const id = generateId();
  const { text, params } = rawGrantInsert(id, action);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER secret_auto_delete_limit');
    await tx.$executeRawUnsafe(text, ...params);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER secret_auto_delete_limit');
  });
  return id;
}
function rawGrantInsert(id: string, action: string) {
  return {
    text: `INSERT INTO grants (id, app_id, user_id, action, action_values, reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'historical mark', clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')`,
    params: [id, w.appId, w.userId, action, JSON.stringify(values(action, 'delete'))],
  };
}

// grants_guard (which fires first, by name) makes terms immutable and refuses the same SQLSTATE, so with it enabled the
// update branches of this trigger are unreachable and mutants of them survive. These pins turn grants_guard off for one
// transaction (rolled back with the refusal) so the secret_auto_delete_limit trigger alone decides.
async function onlyAutoDeleteTrigger<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    const out = await fn(tx);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    return out;
  });
}

describe.each(ACTIONS)('#4001 trigger update branches, isolated from grants_guard, for %s', (action) => {
  it('refuses activating a historical unbounded mark (the activation branch)', async () => {
    const id = await historicalUnboundedMark(action);
    await expect(onlyAutoDeleteTrigger((tx) =>
      tx.$executeRaw`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = ${id}`))
      .rejects.toMatchObject(AUTO_DELETE_REFUSAL);
    expect((await db.grant.findUniqueOrThrow({ where: { id } })).activatedAt).toBeNull();
  });

  it('refuses changing a term of a historical unbounded mark (the changed-terms branch)', async () => {
    const id = await historicalUnboundedMark(action);
    await expect(onlyAutoDeleteTrigger((tx) =>
      tx.$executeRaw`UPDATE grants SET action_values = action_values || '{"note": "x"}'::jsonb WHERE id = ${id}`))
      .rejects.toMatchObject(AUTO_DELETE_REFUSAL);
  });

  it('refuses clearing the finite end of a bounded mark (the changed-terms branch)', async () => {
    const id = await insertGrant(w, { action, action_values: values(action, 'delete'), max_uses: 1 });
    await expect(onlyAutoDeleteTrigger((tx) => tx.$executeRaw`UPDATE grants SET max_uses = NULL WHERE id = ${id}`))
      .rejects.toMatchObject(AUTO_DELETE_REFUSAL);
    expect((await db.grant.findUniqueOrThrow({ where: { id } })).maxUses).toBe(1);
  });

  it('allows a lifecycle-only update of a historical unbounded mark (negative control)', async () => {
    const id = await historicalUnboundedMark(action);
    await expect(onlyAutoDeleteTrigger((tx) =>
      tx.$executeRaw`UPDATE grants SET withdrawn_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = ${id}`)).resolves.toBe(1);
  });

  it('allows adding a finite end to a historical unbounded mark (negative control)', async () => {
    const id = await historicalUnboundedMark(action);
    await expect(onlyAutoDeleteTrigger((tx) => tx.$executeRaw`UPDATE grants SET max_uses = 3 WHERE id = ${id}`)).resolves.toBe(1);
  });
});

it('#4001 does not impose secret auto-delete semantics on unrelated actions', async () => {
  await expect(insertGrant(w, { action: TEST_ACTION, action_values: { 'auto-delete': 'delete' } })).resolves.toBeTruthy();
});
