/**
 * #3852 (follow-on to #3813 / PR #3847; ruling 0265, cor:acl:140:08, cor:acl:140:01, cor:api:010:02): the one-time data
 * migration that clears `grants.requested_by_user_id` on rows whose requester was erased BEFORE #3847's forward path
 * (deleteUser.ts) existed.
 *
 * The rows are built the way an old image left them: the requester's users row is soft-deleted (or never existed) with
 * the link still set, bypassing the forward clear. The migration file itself is then run on a dedicated connection
 * against this checkout's schema (which already carries every earlier migration's guard, so it is the database the
 * migration meets at deploy). Re-running the older #3813 migration here would roll the guard trigger back to an older
 * definition, so only this migration runs.
 *
 * Pins:
 *   1. An erased (soft-deleted) requester and a requester with no users row at all: the link is null after the
 *      migration, and both public reads (grant(ref), grants list) return null.
 *   2. Everything else on the row (version, holder, terms, reason, state, updated_at, every column) is unchanged, the
 *      signatures are unchanged and still verify (CURRENT), and an open signing request on a pending row stays open.
 *   3. A live requester is unchanged.
 *   4. A grant naming an account-merge source (cor:api:010:02) refuses the migration with SQLSTATE HDPRF, the message
 *      carries a count only, and nothing is written (no partial clear). A link already moved to the merge survivor
 *      is untouched.
 *   5. Idempotence: a second run changes nothing; terminal rows (revoked, departed, expired) are cleared too; an
 *      already-null requester stays null.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../../../lib/grants/terms.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from '../../../lib/signing/grantPayload.js';
import { newSigningRequestId } from '../../../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const MIGRATION = new URL('../../../../prisma/migrations/20261121090000_grant_requester_erasure_backfill/migration.sql', import.meta.url);
const RP = 'localhost';
const ORIGIN = 'http://localhost';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

/** Run the migration file on its own connection, as `prisma migrate deploy` does; resolves to the error (with its SQLSTATE) or null. */
async function runMigration(): Promise<{ code?: string; message: string } | null> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return await c.query(readFileSync(MIGRATION, 'utf8')).then(() => null, (err: { code?: string; message: string }) => err);
  } finally { await c.end(); }
}

/** Every column of every grant, signing request and signature, as the database holds them. */
async function snapshot() {
  const rows = (sql: string) => db.$queryRawUnsafe<Array<{ r: Record<string, unknown> }>>(sql).then(x => x.map(y => y.r));
  return {
    grants: await rows('SELECT to_jsonb(g) AS r FROM grants g ORDER BY id'),
    requests: await rows('SELECT to_jsonb(q) AS r FROM grant_signing_requests q ORDER BY id'),
    signatures: await rows('SELECT to_jsonb(s) AS r FROM grant_signatures s ORDER BY id'),
  };
}
const requesterOf = async (g: string) => (await db.grant.findUniqueOrThrow({ where: { id: g } })).requestedByUserId;

let http: Server;
let base: string;
beforeAll(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); await cleanDb(db); await dropTestActions(); });

let w: World;
let rawKey: string;
let sessionId: string;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  w = await seedWorld();
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: w.orgId, userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId: w.userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  rawKey = k;
});

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}`, 'x-hadron-session': sessionId },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json() as any;
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data;
}

/** The grant as both public reads return it: grant(ref:) and the grants list. */
async function readBoth(g: string) {
  const fields = 'id allows requestedByUserId reason issuerUserId verifiedBy signatureId signatureStatus{state integrityProblems}';
  const one = await gql(`query($r:ID!){grant(ref:$r){${fields}}}`, { r: g });
  const list = await gql(`{grants{items{${fields}}}}`);
  return [one.grant, list.grants.items.find((x: { id: string }) => x.id === g)];
}

async function rowTermsHash(grantId: string): Promise<string> {
  const g = await db.grant.findUniqueOrThrow({ where: { id: grantId } });
  return grantTermsHash(grantTermsFromRow({
    appId: g.appId, userId: g.userId, agentId: g.agentId, workerId: g.workerId, granteeAppId: g.granteeAppId,
    action: g.action, values: g.values, startsAt: g.startsAt, expiresAt: g.expiresAt, maxUses: g.maxUses, reason: g.reason,
  }));
}

async function openRequest(g: string): Promise<string> {
  const r = newSigningRequestId();
  await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
    VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, await rowTermsHash(g), GRANT_SIGNATURE_PAYLOAD_V1, w.userId);
  return r;
}

/** A worker-held grant activated by w.user2Id's own soft passkey over the real payload (as #3813's fixture). */
async function signedGrant(requester: string): Promise<string> {
  const g = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: requester });
  const r = await openRequest(g);
  const termsHash = await rowTermsHash(g);
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, w.user2Id, key, { rpId: RP, label: 'Signer key' });
  const a = key.assert({ payload: grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r }), origin: ORIGIN, rpId: RP });
  const s = generateId();
  await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
      holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
    VALUES ($1, $2, $3, $4, $5, 1, $6, 'worker', $7, $8, $9, $10, $11, $12)`,
  s, g, r, w.user2Id, passkeyId, termsHash, w.workerId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
  await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
  await exec(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`, g, w.user2Id, s);
  return g;
}

/** A person erased by an image older than #3847: the users row is soft-deleted, the grant link left set. */
async function erasedUser(): Promise<string> {
  return (await db.user.create({ data: { handle: `erased-${generateId()}`, deletedAt: new Date(), deletedBy: 'system:erasure' } })).id;
}

/** A recorded account merge (cor:api:010:02): the source row soft-deleted, the user_merges row naming it. */
async function mergedPair(): Promise<{ source: string; target: string }> {
  const target = (await db.user.create({ data: { handle: `survivor-${generateId()}` } })).id;
  const source = (await db.user.create({ data: { handle: `merged-${generateId()}`, deletedAt: new Date(), deletedBy: w.userId } })).id;
  await db.userMerge.create({ data: { sourceUserId: source, targetUserId: target, mergedBy: w.userId } });
  return { source, target };
}

/** The snapshot with `ids`' requester link set to null, every other byte as before: what the migration may change. */
function withNulled(before: Awaited<ReturnType<typeof snapshot>>, ids: string[]) {
  return { ...before, grants: before.grants.map(g => (ids.includes(g.id as string) ? { ...g, requested_by_user_id: null } : g)) };
}

describe('#3852 historical erased requesters', () => {
  it('pins 1-3: clears an erased and a no-row requester (storage and both reads); every other byte, signatures and an open request stay; a live requester stays', async () => {
    const erased = await erasedUser();
    const soft = await signedGrant(erased);
    const noRow = await signedGrant(`gone-${generateId()}`);
    const live = await signedGrant(w.userId);
    const pending = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: erased });
    const open = await openRequest(pending);
    for (const g of [soft, noRow]) {
      for (const row of await readBoth(g)) expect(row.requestedByUserId).not.toBeNull();
    }
    const before = await snapshot();

    expect(await runMigration()).toBeNull();
    clearSignatureVerifyCache();

    expect(await snapshot()).toEqual(withNulled(before, [soft, noRow, pending]));
    for (const g of [soft, noRow]) {
      for (const row of await readBoth(g)) {
        expect(row).toMatchObject({ requestedByUserId: null, issuerUserId: w.user2Id, verifiedBy: w.user2Id, allows: true, reason: 'because',
          signatureStatus: { state: 'CURRENT', integrityProblems: 0 } });
      }
    }
    expect(await db.grantSigningRequest.findUniqueOrThrow({ where: { id: open } })).toMatchObject({ state: 'open', version: 1 });
    expect(await db.grant.findUniqueOrThrow({ where: { id: pending } })).toMatchObject({ version: 1, activatedAt: null, requestedByUserId: null });
    for (const row of await readBoth(live)) expect(row).toMatchObject({ requestedByUserId: w.userId, signatureStatus: { state: 'CURRENT', integrityProblems: 0 } });
  });
});

describe('#3852 account-merge sources (cor:api:010:02)', () => {
  it('pin 4: a grant naming a merge source refuses with HDPRF, a count-only message, and no partial write', async () => {
    const { source } = await mergedPair();
    const viaSource = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: source });
    const erasedRow = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: await erasedUser() });
    const before = await snapshot();

    const err = await runMigration();
    expect(err?.code).toBe('HDPRF');
    expect(err?.message).toMatch(/\b1 grant/);
    expect(err?.message).not.toContain(source);
    expect(await snapshot()).toEqual(before);
    expect(await requesterOf(viaSource)).toBe(source);
    expect(await requesterOf(erasedRow)).not.toBeNull();
  });

  it('pin 4: a link already moved to the merge survivor is untouched while an erased link clears', async () => {
    const { target } = await mergedPair();
    const moved = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: target });
    const erasedRow = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: await erasedUser() });
    const before = await snapshot();

    expect(await runMigration()).toBeNull();
    expect(await snapshot()).toEqual(withNulled(before, [erasedRow]));
    expect(await requesterOf(moved)).toBe(target);
  });
});

describe('#3852 idempotence and terminal rows', () => {
  it('pin 5: terminal rows clear too, an already-null link stays null, and a second run changes nothing', async () => {
    const erased = await erasedUser();
    const worker = { user_id: null, worker_id: w.workerId };
    const revoked = await insertGrantUnguarded(w, { ...worker, requested_by_user_id: erased, revoked_at: raw(DB_NOW), revoked_by: w.userId });
    const departed = await insertGrantUnguarded(w, { ...worker, requested_by_user_id: erased, holder_departed_at: raw(DB_NOW) });
    const expired = await insertGrant(w, { ...worker, requested_by_user_id: `gone-${generateId()}`,
      starts_at: raw(`${DB_NOW} - interval '2 days'`), expires_at: raw(`${DB_NOW} - interval '1 day'`) });
    const alreadyNull = await insertGrant(w, { ...worker, requested_by_user_id: null });
    const live = await insertGrant(w, { ...worker, requested_by_user_id: w.user2Id });
    const before = await snapshot();

    expect(await runMigration()).toBeNull();
    const once = await snapshot();
    expect(once).toEqual(withNulled(before, [revoked, departed, expired]));
    expect(await requesterOf(alreadyNull)).toBeNull();
    expect(await requesterOf(live)).toBe(w.user2Id);

    expect(await runMigration()).toBeNull();
    expect(await snapshot()).toEqual(once);
  });
});
