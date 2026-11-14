/**
 * #3668 S1a — the database half of the grant row (prisma/grant-invariants.sql), tested at the database: real constrained
 * INSERTs, UPDATEs and DELETEs. cor:acl:140:01 (one holder, one App, one registered action), :03 (states), :08 (issuer erasure).
 */
import { readFileSync, readdirSync } from 'fs';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { dropTestActions, insertEvent, insertGrant, insertGrantUnguarded, raw, seedWorld, type World, DB_NOW } from './grantFixtures3668.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
const query = <T>(sql: string, ...params: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...params);

describe('prisma/grant-invariants.sql parity', () => {
  it('the newest migration to carry it ends with a byte-identical copy, and post-push includes the file', () => {
    const sql = readFileSync(new URL('../../../prisma/grant-invariants.sql', import.meta.url), 'utf8');
    // #3813: the requester-erasure migration carries the full canonical guard, after activation.
    const dir = readdirSync(new URL('../../../prisma/migrations', import.meta.url)).find((d) => d === '20261110010300_grant_requester_erasure');
    expect(dir).toBeTruthy();
    expect(readFileSync(new URL(`../../../prisma/migrations/${dir}/migration.sql`, import.meta.url), 'utf8').endsWith(sql)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir grant-invariants.sql');
  });
});

describe('exactly one holder (user, agent, worker or App): a NULL truth table', () => {
  const holders = (w: World) => ({ user_id: w.userId, agent_id: w.agentId, worker_id: w.workerId, grantee_app_id: w.app2Id });
  const NONE = { user_id: null, agent_id: null, worker_id: null, grantee_app_id: null };
  it('zero holders is refused', async () => {
    await refused(insertGrant(w, NONE), /chk_grants_exactly_one_holder/);
  });
  it('each single holder passes', async () => {
    for (const [k, v] of Object.entries(holders(w))) await expect(insertGrant(w, { ...NONE, [k]: v }), k).resolves.toBeTruthy();
    expect(await query('SELECT id FROM grants')).toHaveLength(4);
  });
  it('every pair, every triple and all four are refused', async () => {
    const keys = Object.keys(holders(w)) as Array<keyof ReturnType<typeof holders>>;
    for (let mask = 1; mask < 16; mask++) {
      const picked = keys.filter((_, i) => mask & (1 << i));
      if (picked.length < 2) continue;
      const v = { ...NONE, ...Object.fromEntries(picked.map((k) => [k, holders(w)[k]])) };
      await refused(insertGrant(w, v), /chk_grants_exactly_one_holder/);
    }
  });
});

describe('one App, one registered action, a reason', () => {
  it('app_id is required (no org-only row)', async () => {
    await refused(insertGrant(w, { app_id: null }), /23502|null value/i);
  });
  it('an unknown action is refused by the foreign key: no free-text or recorded-only stand-in', async () => {
    await refused(insertGrant(w, { action: 'made.up' }), /grants_action_fkey|foreign key/i);
    await refused(insertGrant(w, { action: '' }), /grants_action_fkey|foreign key|chk_grants_shape/i);
  });
  it('a registered action cannot be removed while a grant names it', async () => {
    await insertGrant(w);
    await refused(exec(`DELETE FROM actions WHERE name = 'test.s1a.act'`), /grants_action_fkey|foreign key/i);
  });
  it('the reason is required and non-blank; counts and times are sane', async () => {
    await refused(insertGrant(w, { reason: '' }), /chk_grants_shape/);
    await refused(insertGrant(w, { reason: null }), /23502|null value/i);
    await refused(insertGrant(w, { max_uses: 0 }), /chk_grants_shape/);
    await refused(insertGrantUnguarded(w, { use_count: -1 }), /chk_grants_shape/);
    await refused(insertGrant(w, { starts_at: dbNowPlus2h(), expires_at: raw(DB_NOW) }), /chk_grants_shape/);
    await expect(insertGrant(w, { max_uses: 1, starts_at: raw(DB_NOW), expires_at: dbNowPlus2h() })).resolves.toBeTruthy();
  });
  it('revoked_at and revoked_by go together', async () => {
    await refused(insertGrantUnguarded(w, { revoked_at: raw(DB_NOW) }), /chk_grants_shape/);
    await refused(insertGrantUnguarded(w, { revoked_by: w.userId }), /chk_grants_shape/);
  });
});
const dbNowPlus2h = () => raw(`${DB_NOW} + interval '2 hours'`);

describe('INSERT guard: a row arrives pending (the database half of ruling 0099)', () => {
  const ARMS: Array<[string, Record<string, unknown>]> = [
    ['activated_at', { activated_at: raw(DB_NOW) }],
    ['verification_kind', { verification_kind: 'PASSKEY' }],
    ['verified_by', { verified_by: 'someone' }],
    ['signature_id', { signature_id: 'sig-1' }],
    ['revoked_at + revoked_by', { revoked_at: raw(DB_NOW), revoked_by: 'someone' }],
    ['use_count', { use_count: 1 }],
    ['version', { version: 2 }],
  ];
  for (const [name, over] of ARMS) {
    it(`${name} set at insert is refused`, async () => {
      await refused(insertGrant(w, over as never), /grants must arrive pending/);
      expect(await query('SELECT id FROM grants')).toHaveLength(0);
    });
  }
  it('an INSERT ... ON CONFLICT upsert cannot activate an existing row either', async () => {
    const id = await insertGrant(w);
    await refused(exec(`INSERT INTO grants (id, app_id, user_id, action, action_values, reason, created_at, updated_at, activated_at)
      VALUES ($1, $2, $3, 'test.s1a.act', '{}'::jsonb, 'because', ${DB_NOW}, ${DB_NOW}, ${DB_NOW})
      ON CONFLICT (id) DO UPDATE SET activated_at = EXCLUDED.activated_at`, id, w.appId, w.userId), /grants must arrive pending|append-only/);
    expect((await query<{ activated_at: unknown }>('SELECT activated_at FROM grants WHERE id = $1', id))[0].activated_at).toBeNull();
  });
});

describe('UPDATE guard: a row ends once, loses an erased issuer, follows a merge, and is otherwise never edited', () => {
  const EDITS: Array<[string, string]> = [
    ['reason', `reason = 'other'`], ['action_values', `action_values = '{"a":1}'::jsonb`], ['max_uses', 'max_uses = 5'],
    ['expires_at', `expires_at = ${DB_NOW} + interval '1 day'`], ['starts_at', `starts_at = ${DB_NOW}`], ['app_id', `app_id = '__APP2__'`],
    ['holder', `user_id = NULL, agent_id = '__AGENT__'`], ['activated_at', `activated_at = ${DB_NOW}`], ['verified_by', `verified_by = 'x'`],
    ['verification_kind', `verification_kind = 'PASSKEY'`], ['signature_id', `signature_id = 's'`], ['use_count', 'use_count = 1'],
    ['version', 'version = 2'], ['action', `action = 'test.s1a.other'`], ['created_at', `created_at = ${DB_NOW} - interval '1 day'`],
  ];
  for (const [name, set] of EDITS) {
    it(`editing ${name} is refused`, async () => {
      const id = await insertGrant(w, { issuer_user_id: w.userId });
      const sql = set.replace('__APP2__', w.app2Id).replace('__AGENT__', w.agentId);
      await refused(exec(`UPDATE grants SET ${sql} WHERE id = $1`, id), /grants are append-only/);
    });
  }
  it('revoking is allowed once, with revoked_by; a second revoke and an un-revoke are refused', async () => {
    const id = await insertGrant(w);
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = $2, updated_at = ${DB_NOW} WHERE id = $1`, id, w.userId);
    // A real later instant (timestamp(3) would often collide with the first stamp), so only the revoke-once arm can refuse.
    await exec('SELECT pg_sleep(0.05)');
    await refused(exec(`UPDATE grants SET revoked_at = ${DB_NOW} WHERE id = $1`, id), /grants are append-only/); // same revoker, re-stamped
    await refused(exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'other' WHERE id = $1`, id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET revoked_at = NULL, revoked_by = NULL WHERE id = $1`, id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET revoked_by = 'other' WHERE id = $1`, id), /grants are append-only/);
  });
  it('erasing the issuer nulls the link and keeps the reason (cor:acl:140:08)', async () => {
    const id = await insertGrant(w, { issuer_user_id: w.userId, reason: 'kept words' });
    // #3690: the link goes only for an ERASED person (the users row soft-deleted or gone); a live person's is refused.
    await refused(exec(`UPDATE grants SET issuer_user_id = NULL WHERE id = $1`, id), /grants are append-only/);
    await db.user.update({ where: { id: w.userId }, data: { deletedAt: new Date() } });
    await exec(`UPDATE grants SET issuer_user_id = NULL WHERE id = $1`, id);
    expect((await query<{ issuer_user_id: unknown; reason: string }>('SELECT issuer_user_id, reason FROM grants WHERE id = $1', id))[0]).toEqual({ issuer_user_id: null, reason: 'kept words' });
    await refused(exec(`UPDATE grants SET issuer_user_id = $2 WHERE id = $1`, id, w.user2Id), /grants are append-only/);
  });
  const recordMerge = (from: string, to: string) => exec(`INSERT INTO user_merges (source_user_id, target_user_id, merged_at) VALUES ($1, $2, ${DB_NOW})`, from, to);
  it('a person link moves ONLY from a merged-away user to its recorded survivor', async () => {
    const id = await insertGrant(w, { issuer_user_id: w.userId, requested_by_user_id: w.userId });
    const move = `UPDATE grants SET issuer_user_id = $2, requested_by_user_id = $2, user_id = $2 WHERE id = $1`;
    await refused(exec(move, id, w.user2Id), /grants are append-only/); // no merge recorded
    await recordMerge(w.user2Id, w.userId); // the WRONG direction proves nothing
    await refused(exec(move, id, w.user2Id), /grants are append-only/);
    await recordMerge(w.userId, w.user2Id);
    await exec(move, id, w.user2Id);
    expect((await query<{ issuer_user_id: string; user_id: string; requested_by_user_id: string }>('SELECT issuer_user_id, user_id, requested_by_user_id FROM grants WHERE id = $1', id))[0])
      .toEqual({ issuer_user_id: w.user2Id, user_id: w.user2Id, requested_by_user_id: w.user2Id });
  });
  const LINKS: Array<[string, Record<string, unknown>]> = [
    ['user_id', {}], ['issuer_user_id', { issuer_user_id: 'U' }], ['requested_by_user_id', { requested_by_user_id: 'U' }],
  ];
  for (const [col, extra] of LINKS) {
    it(`${col} alone: refused without a recorded merge, refused to a different user, allowed to the recorded survivor`, async () => {
      const id = await insertGrant(w, Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === 'U' ? w.userId : v])) as never);
      const set = `UPDATE grants SET ${col} = $2 WHERE id = $1`;
      await refused(exec(set, id, w.user2Id), /grants are append-only/);
      const third = await db.user.create({ data: { handle: `g3-${col}` } });
      await recordMerge(w.userId, w.user2Id);
      await refused(exec(set, id, third.id), /grants are append-only/);
      await exec(set, id, w.user2Id);
      expect((await query<Record<string, string>>(`SELECT ${col} FROM grants WHERE id = $1`, id))[0][col]).toBe(w.user2Id);
    });
  }
  it('verified_by alone follows the same rule', async () => {
    const id = await insertGrantUnguarded(w, { activated_at: raw(DB_NOW), verified_by: w.userId });
    await refused(exec(`UPDATE grants SET verified_by = $2 WHERE id = $1`, id, w.user2Id), /grants are append-only/);
    await recordMerge(w.userId, w.user2Id);
    await exec(`UPDATE grants SET verified_by = $2 WHERE id = $1`, id, w.user2Id);
  });
  it('a recorded merge moves person links only: no other column, no App, no change of holder kind, nothing to a different user', async () => {
    const id = await insertGrant(w, { issuer_user_id: w.userId });
    await recordMerge(w.userId, w.user2Id);
    await refused(exec(`UPDATE grants SET reason = 'x' WHERE id = $1`, id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET app_id = $2 WHERE id = $1`, id, w.app2Id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET user_id = NULL, agent_id = $2 WHERE id = $1`, id, w.agentId), /grants are append-only/);
    const third = await db.user.create({ data: { handle: 'g3-other' } });
    await refused(exec(`UPDATE grants SET issuer_user_id = $2 WHERE id = $1`, id, third.id), /grants are append-only/);
    await refused(exec(`UPDATE grants SET user_id = NULL WHERE id = $1`, id), /grants are append-only|chk_grants_exactly_one_holder/);
  });
  it('a revoker follows a recorded merge too, and only then', async () => {
    const id = await insertGrant(w);
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = $2 WHERE id = $1`, id, w.userId);
    await refused(exec(`UPDATE grants SET revoked_by = $2 WHERE id = $1`, id, w.user2Id), /grants are append-only/);
    await recordMerge(w.userId, w.user2Id);
    await exec(`UPDATE grants SET revoked_by = $2 WHERE id = $1`, id, w.user2Id);
  });
});

describe('DELETE: refused while the App lives; the App\'s hard delete carries the rows away', () => {
  it('refuses a row delete', async () => {
    const id = await insertGrant(w);
    await refused(exec('DELETE FROM grants WHERE id = $1', id), /grants are append-only/);
  });
  it('allows it once the App is gone (the FK cascade), including the events', async () => {
    const id = await insertGrant(w);
    await insertEvent(w, id);
    await db.app.delete({ where: { id: w.appId } });
    expect(await query('SELECT id FROM grants')).toHaveLength(0);
    expect(await query('SELECT id FROM grant_events')).toHaveLength(0);
  });
  // #3690 S2a-h replaced the S1a INTERIM RESTRICT: a holder that goes ends its grant (holderDeparture3690.test.ts pins every kind).
  it('an App that is BOTH a grant\'s scope and its holder deletes cleanly: the scope cascade takes the row first', async () => {
    await insertGrant(w, { user_id: null, grantee_app_id: w.appId });
    await db.app.delete({ where: { id: w.appId } });
    expect(await query('SELECT id FROM grants')).toHaveLength(0);
  });
});

describe('grant_events are append-only: UPDATE, INSERT-rewrite and DELETE', () => {
  it('records an event, and an unknown event kind is refused', async () => {
    const g = await insertGrant(w);
    for (const action of ['CREATE', 'ACTIVATE', 'REVOKE', 'USE']) await insertEvent(w, g, { action });
    await refused(insertEvent(w, g, { action: 'EDIT' }), /chk_grant_events_shape/);
    expect(await query('SELECT id FROM grant_events')).toHaveLength(4);
  });
  it('refuses an UPDATE of any column', async () => {
    const g = await insertGrant(w);
    const e = await insertEvent(w, g);
    for (const set of [`action = 'REVOKE'`, `actor_user_id = 'x'`, `grant_id = 'other'`, `app_id = '${w.app2Id}'`, `session_id = 's'`]) {
      await refused(exec(`UPDATE grant_events SET ${set} WHERE id = $1`, e), /grant events are append-only/);
    }
  });
  it('refuses an INSERT that rewrites an existing event (ON CONFLICT DO UPDATE)', async () => {
    const g = await insertGrant(w);
    const e = await insertEvent(w, g, { action: 'CREATE' });
    await refused(exec(`INSERT INTO grant_events (id, grant_id, app_id, action, at) VALUES ($1, $2, $3, 'REVOKE', ${DB_NOW})
      ON CONFLICT (id) DO UPDATE SET action = EXCLUDED.action`, e, g, w.appId), /grant events are append-only/);
    expect((await query<{ action: string }>('SELECT action FROM grant_events WHERE id = $1', e))[0].action).toBe('CREATE');
  });
  it('refuses a DELETE while the App exists, and allows it after the App is gone', async () => {
    const g = await insertGrant(w);
    const e = await insertEvent(w, g);
    await refused(exec('DELETE FROM grant_events WHERE id = $1', e), /grant events are append-only/);
    await db.app.delete({ where: { id: w.appId } });
    expect(await query('SELECT id FROM grant_events')).toHaveLength(0);
  });
  it('the event time defaults to the database clock, and actor ids carry no foreign key (sealed history)', async () => {
    const g = await insertGrant(w);
    const e = await insertEvent(w, g, { actor_user_id: 'a-user-that-was-erased-long-ago' });
    const [row] = await query<{ at: Date }>('SELECT at FROM grant_events WHERE id = $1', e);
    expect(Math.abs(row.at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});

describe('cleanDb', () => {
  it('truncates grants and grant_events (a row delete would be refused)', async () => {
    const g = await insertGrant(w);
    await insertEvent(w, g);
    await cleanDb(db);
    expect(await query('SELECT id FROM grants')).toHaveLength(0);
    expect(await query('SELECT id FROM grant_events')).toHaveLength(0);
  });
});
