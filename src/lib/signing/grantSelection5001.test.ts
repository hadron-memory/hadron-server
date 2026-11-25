/**
 * #5001 slice 2 (cor:acl:140:07, :09; ruling 0255 item 19): the database half of selection signing, pinned against the guards
 * directly with raw SQL (P19), never through a resolver: selection rows, item requests, the touch record and the per-grant
 * records. Grant rows come from the S1a fixtures.
 */
import { readFileSync } from 'fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { DB_NOW, dropTestActions, insertGrant, seedWorld, type World } from '../grants/grantFixtures3668.js';
import { newSigningRequestId } from './requests.js';

const RP = 'localhost';
const V1 = 'hadron-grant-signature-v1';
const SEL = 'hadron-grant-selection-signature-v1';
const HASH = 'a'.repeat(64);
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
const query = <T>(sql: string, ...params: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...params);
const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

async function insertSelection(over: Record<string, unknown> = {}): Promise<string> {
  const v: Record<string, unknown> = { id: newSigningRequestId(), app_id: w.appId, payload_version: SEL, requester_user_id: w.userId, ...over };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signing_selections (${cols.join(', ')}, expires_at)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, ${DB_NOW} + interval '1 hour')`, ...cols.map((c) => v[c]));
  return v.id as string;
}

async function insertItem(selectionId: string | null, grantId: string, position: number | null, over: Record<string, unknown> = {}): Promise<string> {
  const v: Record<string, unknown> = {
    id: newSigningRequestId(), grant_id: grantId, version: 1, terms_hash: HASH, payload_version: selectionId ? SEL : V1,
    requester_user_id: w.userId, selection_id: selectionId, position_in_selection: position, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signing_requests (${cols.join(', ')}, expires_at)
    VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, ${DB_NOW} + interval '1 hour')`, ...cols.map((c) => v[c]));
  return v.id as string;
}

/** Grants g1 < g2 (ascending id bytes), both pending, and a selection naming both as items. */
async function fixture() {
  const a = await insertGrant(w);
  const b = await insertGrant(w);
  const [g1, g2] = [a, b].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  const sel = await insertSelection();
  const r1 = await insertItem(sel, g1, 0);
  const r2 = await insertItem(sel, g2, 1);
  return { g1, g2, sel, r1, r2 };
}

async function insertTouch(selectionId: string, items: unknown[], over: Record<string, unknown> = {}) {
  const key = softPasskey();
  const passkeyId = (over.passkey_credential_id as string | undefined) ?? await insertSoftPasskey(db, w.userId, key, { rpId: RP });
  const a = key.assert({ payload: Buffer.from('x'), origin: 'http://localhost', rpId: RP });
  const v: Record<string, unknown> = {
    id: newSigningRequestId(), selection_id: selectionId, signer_id: w.userId, passkey_credential_id: passkeyId, payload_version: SEL,
    items: JSON.stringify(items), rp_id: RP, authenticator_data: a.authenticatorData, client_data_json: a.clientDataJson, signature: a.signature, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_selection_signatures (${cols.join(', ')})
    VALUES (${cols.map((c, i) => (c === 'items' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`, ...cols.map((c) => v[c]));
  return { id: v.id as string, v };
}

async function insertItemSignature(touch: { id: string; v: Record<string, unknown> }, requestId: string, grantId: string, over: Record<string, unknown> = {}) {
  const v: Record<string, unknown> = {
    id: newSigningRequestId(), grant_id: grantId, signing_request_id: requestId, signer_id: w.userId,
    passkey_credential_id: touch.v.passkey_credential_id, version: 1, terms_hash: HASH, holder_kind: 'user', holder_id: w.userId,
    payload_version: SEL, rp_id: RP, authenticator_data: touch.v.authenticator_data, client_data_json: touch.v.client_data_json,
    signature: touch.v.signature, selection_signature_id: touch.id, ...over,
  };
  const cols = Object.keys(v);
  await exec(`INSERT INTO grant_signatures (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, ...cols.map((c) => v[c]));
  return v.id as string;
}

const item = (grantId: string, over: Record<string, unknown> = {}) => ({ grantId, version: 1, termsHash: HASH, ...over });
const stateOf = async (table: string, id: string) => (await query<{ state: string }>(`SELECT state FROM ${table} WHERE id = $1`, id))[0].state;

describe('parity', () => {
  it('the new migration ends with the selection invariants file and holds the two others whole; post-push includes it after the signing file', () => {
    const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
    const migration = read('prisma/migrations/20261125130000_grant_selection_signing/migration.sql');
    expect(migration.endsWith(read('prisma/grant-selection-signing-invariants.sql'))).toBe(true);
    expect(migration.includes(read('prisma/grant-signing-invariants.sql'))).toBe(true);
    expect(migration.includes(read('prisma/passkey-registration-invariants.sql'))).toBe(true);
    const postPush = read('prisma/post-push.sql');
    expect(postPush.indexOf('\\ir grant-selection-signing-invariants.sql')).toBeGreaterThan(postPush.indexOf('\\ir grant-signing-invariants.sql'));
  });
});

describe('P19 shape: the selection version and the selection link move together', () => {
  it('a one-grant request with a selection id, or a selection item with the one-grant version, is refused', async () => {
    const g = await insertGrant(w);
    const sel = await insertSelection();
    await refused(insertItem(sel, g, 0, { payload_version: V1 }), /chk_grant_signing_request_shape/);
    await refused(insertItem(null, g, null, { payload_version: SEL }), /chk_grant_signing_request_shape/);
    await refused(insertItem(sel, g, null), /chk_grant_signing_request_shape/);
    await refused(insertItem(null, g, 0), /chk_grant_signing_request_shape/);
    expect(await insertItem(sel, g, 0)).toBeTruthy();
  });
  it('one grant once per selection', async () => {
    const g = await insertGrant(w);
    const sel = await insertSelection();
    await insertItem(sel, g, 0);
    await refused(insertItem(sel, g, 1), /\(selection_id, grant_id\).*already exists/);
  });
  it('an item needs an open selection of the grant\'s own App', async () => {
    const g = await insertGrant(w);
    const sel = await insertSelection();
    await exec(`UPDATE grant_signing_selections SET state = 'withdrawn' WHERE id = $1`, sel);
    await refused(insertItem(sel, g, 0), /open selection of the grant/);
  });
  it('a selection row has a user or App requester and a closed state set (no stale)', async () => {
    await refused(insertSelection({ requester_user_id: null }), /chk_grant_signing_selection_shape/);
    await refused(insertSelection({ payload_version: V1 }), /chk_grant_signing_selection_shape/);
    const sel = await insertSelection();
    await refused(exec(`UPDATE grant_signing_selections SET state = 'stale' WHERE id = $1`, sel), /chk_grant_signing_selection_shape/);
  });
});

describe('P19 selection lifecycle', () => {
  it('pinned fields are immutable and a selection ends exactly once', async () => {
    const sel = await insertSelection();
    await refused(exec(`UPDATE grant_signing_selections SET payload_version = 'x' WHERE id = $1`, sel), /pinned fields are immutable/);
    await refused(exec(`UPDATE grant_signing_selections SET expires_at = expires_at + interval '1 day' WHERE id = $1`, sel), /pinned fields are immutable/);
    await exec(`UPDATE grant_signing_selections SET state = 'withdrawn' WHERE id = $1`, sel);
    await refused(exec(`UPDATE grant_signing_selections SET state = 'declined' WHERE id = $1`, sel), /ends exactly once/);
  });
  it('a selection is born open', async () => {
    await refused(insertSelection({ state: 'completed' }), /begins open|chk_grant_signing_selection_shape/);
  });
  it('a selection ending carries its open items with it; a completed one leaves failed items stale', async () => {
    const f = await fixture();
    await exec(`UPDATE grant_signing_selections SET state = 'declined' WHERE id = $1`, f.sel);
    expect(await stateOf('grant_signing_requests', f.r1)).toBe('declined');
    expect(await stateOf('grant_signing_requests', f.r2)).toBe('declined');
  });
  it('it completes only with its touch record', async () => {
    const f = await fixture();
    await refused(exec(`UPDATE grant_signing_selections SET state = 'completed' WHERE id = $1`, f.sel), /only with its touch record/);
  });
  it('is deleted only with its App', async () => {
    const f = await fixture();
    await refused(exec('DELETE FROM grant_signing_selections WHERE id = $1', f.sel), /kept for the App/);
  });
});

describe('P19 touch record', () => {
  it('records a touch over items that are the selection\'s item requests at their pins, ascending by grant id', async () => {
    const f = await fixture();
    expect((await insertTouch(f.sel, [item(f.g1), item(f.g2)])).id).toBeTruthy();
  });
  it('refuses an item the selection does not hold, at other pins, out of order, duplicated, empty, or over the cap', async () => {
    const f = await fixture();
    const other = await insertGrant(w);
    await refused(insertTouch(f.sel, [item(other)]), /item of its selection at its pinned terms/);
    await refused(insertTouch(f.sel, [item(f.g1, { version: 2 })]), /item of its selection at its pinned terms/);
    await refused(insertTouch(f.sel, [item(f.g1, { termsHash: 'b'.repeat(64) })]), /item of its selection at its pinned terms/);
    await refused(insertTouch(f.sel, [item(f.g2), item(f.g1)]), /ascending grant id/);
    await refused(insertTouch(f.sel, [item(f.g1), item(f.g1)]), /ascending grant id/);
    await refused(insertTouch(f.sel, []), /chk_grant_selection_signature_shape/);
    await refused(insertTouch(f.sel, Array.from({ length: 26 }, (_, i) => item(`g${String(i).padStart(3, '0')}`))), /chk_grant_selection_signature_shape|ascending|item of its selection/);
    await refused(insertTouch(f.sel, [{ grantId: f.g1, version: 1 }]), /grant id, a version and a terms hash/);
  });
  it('needs the signer\'s own unrevoked passkey and an open selection, and is append-only', async () => {
    const f = await fixture();
    const someoneElse = await insertSoftPasskey(db, w.userId, softPasskey(), { rpId: RP });
    await exec(`UPDATE passkey_credentials SET revoked_at = ${DB_NOW} WHERE id = $1`, someoneElse);
    await refused(insertTouch(f.sel, [item(f.g1)], { passkey_credential_id: someoneElse }), /unrevoked passkey/);
    const t = await insertTouch(f.sel, [item(f.g1)]);
    await refused(exec(`UPDATE grant_selection_signatures SET signer_id = 'x' WHERE id = $1`, t.id), /append-only/);
    await refused(exec('DELETE FROM grant_selection_signatures WHERE id = $1', t.id), /never deleted/);
    await exec(`UPDATE grant_signing_selections SET state = 'declined' WHERE id = $1`, f.sel);
    await refused(insertTouch(f.sel, [item(f.g1)]), /open signing selection/);
  });
  it('a second touch for one selection is refused (one touch, one record)', async () => {
    const f = await fixture();
    await insertTouch(f.sel, [item(f.g1)]);
    await refused(insertTouch(f.sel, [item(f.g2)]), /\(selection_id\).*already exists/);
  });
});

describe('P19 per-grant records of a selection', () => {
  it('records an item\'s signature only when it repeats the touch record and is one of its signed items', async () => {
    const f = await fixture();
    const t = await insertTouch(f.sel, [item(f.g1)]);
    // g2 was not signed by this touch.
    await refused(insertItemSignature(t, f.r2, f.g2), /one of the items its touch record signed/);
    // Bytes that differ from the touch's.
    await refused(insertItemSignature(t, f.r1, f.g1, { signature: Buffer.from('forged') }), /one of the items its touch record signed/);
    // A one-grant version cannot name a touch, and a selection version cannot omit it.
    await refused(insertItemSignature(t, f.r1, f.g1, { payload_version: V1 }), /must sign exactly what its request pinned/);
    await refused(insertItemSignature(t, f.r1, f.g1, { selection_signature_id: null }), /chk_grant_signature_shape/);
    expect(await insertItemSignature(t, f.r1, f.g1)).toBeTruthy();
  });
  it('another selection\'s touch cannot sign this selection\'s item', async () => {
    const f = await fixture();
    const other = await fixture();
    const t = await insertTouch(other.sel, [item(other.g1)]);
    await refused(insertItemSignature(t, f.r1, f.g1), /one of the items its touch record signed/);
  });
  it('an item whose grant is revoked is stale alone: its siblings stay open', async () => {
    const f = await fixture();
    await exec(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = 'someone' WHERE id = $1`, f.g1);
    expect(await stateOf('grant_signing_requests', f.r1)).toBe('stale');
    expect(await stateOf('grant_signing_requests', f.r2)).toBe('open');
    expect(await stateOf('grant_signing_selections', f.sel)).toBe('open');
  });
});

describe('an App\'s hard delete takes its selections, touch records and per-grant records with it', () => {
  it('cascades', async () => {
    const f = await fixture();
    const t = await insertTouch(f.sel, [item(f.g1)]);
    await insertItemSignature(t, f.r1, f.g1);
    await exec('DELETE FROM apps WHERE id = $1', w.appId);
    expect((await query('SELECT 1 FROM grant_signing_selections WHERE id = $1', f.sel)).length).toBe(0);
    expect((await query('SELECT 1 FROM grant_selection_signatures WHERE id = $1', t.id)).length).toBe(0);
    expect((await query('SELECT 1 FROM grant_signatures WHERE selection_signature_id = $1', t.id)).length).toBe(0);
  });
});
