/**
 * #4690 (remedy for #3851's finding hrn:node:hadronmemory.com:hadron-server:findings:crossed-erasure-grant-update-deadlock-is-not-retried):
 * two concurrent erasures of two people whose grants are crossed (G1: requester A, issuer B; G2: requester B, issuer A)
 * deadlock in deleteUserAccount's grant writes. Postgres aborts one with 40P01, so that erasure must be re-run, not
 * surfaced as a raw P2010. The real path is staged with a deterministic barrier (lock-holder transactions plus
 * pg_stat_activity waits, no sleeps), as in the #3851 probe. hrn:node:hadronmemory.com:specs:cor:aut:020:03 (one atomic
 * operation), hrn:node:hadronmemory.com:specs:cor:acl:140:08 (the links read as a deleted user; everything else unchanged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { Prisma } from '../../generated/prisma/index.js';
import { DB_NOW, insertGrant, seedWorld, type World } from '../../lib/grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../../lib/grants/terms.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from '../../lib/signing/grantPayload.js';
import { newSigningRequestId } from '../../lib/signing/requests.js';
import { deleteUserAccount } from './deleteUser.js';
import { DEADLOCK_RETRIES, SERIALIZATION_RETRIES, isDeadlock, isSerializationFailure } from '../../lib/serializableRetry.js';
import { purgeCollectedAssetObjects } from '../../lib/asset/purge.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { writeNodeToGit } from '../../integrations/github/writeNodeToGit.js';
import { getBusClient } from '../../lib/bus/index.js';
import { waitForLockWaiters } from '../../test/lockWait.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
// #4811 F3: the post-commit asset purge is the one outside effect an erasure always reaches; count it (the real one still runs).
vi.mock('../../lib/asset/purge.js', async (orig) => {
  const actual = await orig<typeof import('../../lib/asset/purge.js')>();
  return { ...actual, purgeCollectedAssetObjects: vi.fn(actual.purgeCollectedAssetObjects) };
});

const RP = 'localhost';
const ORIGIN = 'http://localhost';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
let w: World;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(async () => { await cleanDb(db); w = await seedWorld(); vi.mocked(writeNodeToGit).mockClear(); vi.mocked(getBusClient).mockClear(); vi.mocked(purgeCollectedAssetObjects).mockClear(); });
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = undefined; }); // restore only what a test took; the factory mocks keep their implementations (#4811 F3)

async function person(tag: string, roles: Array<'ADMIN'> = []) {
  const suffix = generateId().slice(0, 6);
  return db.user.create({ data: { handle: `${tag}-${suffix}`, email: `${tag}-${suffix}@example.test`, ...(roles.length ? { roles } : {}) } });
}
async function rowTermsHash(grantId: string): Promise<string> {
  const g = await db.grant.findUniqueOrThrow({ where: { id: grantId } });
  return grantTermsHash(grantTermsFromRow({ appId: g.appId, userId: g.userId, agentId: g.agentId, workerId: g.workerId, granteeAppId: g.granteeAppId,
    action: g.action, values: g.values, startsAt: g.startsAt, expiresAt: g.expiresAt, maxUses: g.maxUses, reason: g.reason }));
}
/** A worker-held, passkey-signed, activated grant: issuer = signer, requester as given. */
async function signGrant(signer: string, requester: string): Promise<string> {
  const g = await insertGrant(w, { user_id: null, worker_id: w.workerId, requested_by_user_id: requester });
  const termsHash = await rowTermsHash(g);
  const r = newSigningRequestId();
  await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
    VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, termsHash, GRANT_SIGNATURE_PAYLOAD_V1, w.userId);
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, signer, key, { rpId: RP, label: 'Signer key' });
  const payload = grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r });
  const a = key.assert({ payload, origin: ORIGIN, rpId: RP });
  const s = generateId();
  await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
      holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
    VALUES ($1, $2, $3, $4, $5, 1, $6, 'worker', $7, $8, $9, $10, $11, $12)`,
  s, g, r, signer, passkeyId, termsHash, w.workerId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
  await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
  await exec(`UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`, g, signer, s);
  return g;
}

/** A transaction held open by the test, standing in for a lock holder. */
async function holder(sql: string, ...params: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const done = db.$transaction(async (t) => { await t.$queryRawUnsafe(sql, ...params); ready(); await gate; }, { timeout: 60_000 });
  await readyP;
  return { release, done };
}
const waiters = () => db.$queryRaw<Array<{ pid: number; q: string }>>`
  SELECT pid, left(query, 120) AS q FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() ORDER BY pid`;
async function waitForWaiterMatching(re: RegExp, n: number, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const ws = (await waiters()).filter((x) => re.test(x.q));
    if (ws.length >= n) return ws;
    if (Date.now() > end) throw new Error(`no ${n} waiter(s) matching ${re}: ${JSON.stringify(await waiters())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
/**
 * Counts, per client, the transactions opened through it (each attempt of the erasure opens one) and the ones that Postgres
 * aborted as a deadlock (SQLSTATE 40P01, by the same structured test the retry uses), so a test can tell a deadlock re-run
 * from a serialization re-run (#4811 F2). It intercepts only the public `$transaction` entry by name, and a break is loud:
 * the counter would stay 0 and every count assertion here fails (pinned by the single-erasure test below, #4811 F7).
 */
function counting() {
  const counter = { transactions: 0, deadlocks: 0 };
  const proxied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (...a: unknown[]) => {
          counter.transactions += 1;
          return (target.$transaction as (...x: unknown[]) => Promise<unknown>)(...a).catch((e: unknown) => {
            if (isDeadlock(e)) counter.deadlocks += 1;
            throw e;
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxied as typeof db, counter };
}
const settle = (p: Promise<void>) => p.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e }));
const grantState = (ids: string[]) => db.grant.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' },
  select: { id: true, issuerUserId: true, requestedByUserId: true, reason: true, activatedAt: true, signatureId: true, verifiedBy: true } });

/**
 * Stage the crossed deadlock on the real path. Both erasures first queue on their issuer write (A on G2, B on G1).
 * Releasing G2 lets A take it and move on to its requester write, which waits on G1. Releasing G1 then lets B take G1 and
 * want G2 (held by A) while A wants G1 (held by B): a deadlock, and Postgres aborts one with 40P01.
 */
async function crossedErasures(eraseA: () => Promise<void>, eraseB: () => Promise<void>, G1: string, G2: string) {
  const h1 = await holder('SELECT id FROM grants WHERE id = $1 FOR UPDATE', G1);
  const h2 = await holder('SELECT id FROM grants WHERE id = $1 FOR UPDATE', G2);
  const a = settle(eraseA());
  const b = settle(eraseB());
  try {
    // These match deleteUser.ts's two grant writes by their SQL text (the issuer UPDATE sets issuer_user_id, the requester
    // UPDATE sets requested_by_user_id); a refactor that renames or merges them fails here loudly, by design.
    await waitForWaiterMatching(/issuer_user_id/, 2);
    h2.release(); await h2.done;
    await waitForWaiterMatching(/requested_by_user_id/, 1);
  } finally {
    // Never leave a holder open past the test: a timeout above would otherwise reject later, inside another test.
    h2.release(); h1.release();
    await Promise.allSettled([h1.done, h2.done]);
  }
  return Promise.all([a, b]);
}

describe('#4690 crossed erasures deadlock: the aborted erasure is re-run, not surfaced', () => {
  it('two crossed self-erasures both complete; the loser re-runs its transaction; the links are null and nothing else moved', async () => {
    const A = await person('a'); const B = await person('b');
    const G1 = await signGrant(B.id, A.id); // requester A, issuer B
    const G2 = await signGrant(A.id, B.id); // requester B, issuer A
    const before = await grantState([G1, G2]);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ca = counting(); const cb = counting();
    const [ra, rb] = await crossedErasures(
      () => deleteUserAccount(ca.db, { targetUserId: A.id, actorUserId: A.id }),
      () => deleteUserAccount(cb.db, { targetUserId: B.id, actorUserId: B.id }), G1, G2);
    expect(ra).toEqual({ ok: true });
    expect(rb).toEqual({ ok: true });
    // One of the two ran once; the deadlock victim re-ran its transaction (a serialization retry may follow it, since it
    // re-reads what the winner just committed under SERIALIZABLE).
    const attempts = [ca.counter.transactions, cb.counter.transactions].sort((x, y) => x - y);
    expect(attempts[0]).toBe(1);
    expect(attempts[1]).toBeGreaterThanOrEqual(2);
    // #4811 F2: the re-run was a DEADLOCK re-run: a 40P01 was seen, by exactly one of the two (a serialization retry alone
    // would also give attempts >= 2).
    expect(ca.counter.deadlocks + cb.counter.deadlocks).toBe(1);
    expect(attempts[1]).toBeLessThanOrEqual((SERIALIZATION_RETRIES + 1) * (DEADLOCK_RETRIES + 1));
    // The retried closure is database-only: it never reaches the outside effects this file mocks, on any attempt.
    expect(vi.mocked(writeNodeToGit)).not.toHaveBeenCalled();
    expect(vi.mocked(getBusClient)).not.toHaveBeenCalled();
    // #4811 F3: and it reaches no outside effect through any other client: no HTTP call, and the post-commit asset purge ran
    // once per erasure (2), not once per attempt.
    expect(fetchSpy!).not.toHaveBeenCalled();
    expect(vi.mocked(purgeCollectedAssetObjects)).toHaveBeenCalledTimes(2);
    const users = await db.user.findMany({ where: { id: { in: [A.id, B.id] } }, select: { deletedAt: true } });
    expect(users.every((u) => u.deletedAt !== null)).toBe(true);
    const after = await grantState([G1, G2]);
    expect(after.map((g) => [g.issuerUserId, g.requestedByUserId])).toEqual([[null, null], [null, null]]);
    // cor:acl:140:08: reasons, activation, verification and signatures are untouched.
    expect(after.map(({ reason, activatedAt, signatureId, verifiedBy }) => ({ reason, activatedAt, signatureId, verifiedBy })))
      .toEqual(before.map(({ reason, activatedAt, signatureId, verifiedBy }) => ({ reason, activatedAt, signatureId, verifiedBy })));
  });

  it('a crossed erasure by an administrator with a reason, deadlock-aborted and re-run, leaves exactly one audit row', async () => {
    const admin = await person('admin', ['ADMIN']);
    const A = await person('a'); const B = await person('b');
    const G1 = await signGrant(B.id, A.id);
    const G2 = await signGrant(A.id, B.id);
    const ca = counting(); const cb = counting();
    const [ra, rb] = await crossedErasures(
      () => deleteUserAccount(ca.db, { targetUserId: A.id, actorUserId: admin.id, reason: 'crossed-erasure audit pin' }),
      () => deleteUserAccount(cb.db, { targetUserId: B.id, actorUserId: B.id }), G1, G2);
    expect(ra).toEqual({ ok: true });
    expect(rb).toEqual({ ok: true });
    // #4811 F1: the administrator's erasure (the one that writes the audit row) is the deadlock victim: the barrier
    // (crossedErasures) waits until A is queued on its requester write before h1 is released, so A's wait is the older one and
    // Postgres's detector fires in A's backend. It ran at least twice, after a seen 40P01.
    expect(ca.counter.deadlocks).toBe(1);
    expect(ca.counter.transactions).toBeGreaterThanOrEqual(2);
    expect(cb.counter.deadlocks).toBe(0);
    // Not claimed: that the audit id is reused across attempts. An aborted attempt rolls its audit insert back, so a row count
    // cannot tell a minted-once id from one minted per attempt (#4811, LOCAL F1); this pins "one row after the re-run" only.
    expect(await db.userDeletionAudit.count({ where: { targetUserId: A.id } })).toBe(1);
  });

  it('control: two unrelated erasures at the same barrier both complete', async () => {
    const C = await person('c'); const D = await person('d'); const E = await person('e'); const F = await person('f');
    const G3 = await signGrant(E.id, C.id); const G4 = await signGrant(F.id, D.id);
    const h3 = await holder('SELECT id FROM grants WHERE id = $1 FOR UPDATE', G3);
    const h4 = await holder('SELECT id FROM grants WHERE id = $1 FOR UPDATE', G4);
    const cc = counting(); const cd = counting();
    try {
      const ec = settle(deleteUserAccount(cc.db, { targetUserId: C.id, actorUserId: C.id }));
      const ed = settle(deleteUserAccount(cd.db, { targetUserId: D.id, actorUserId: D.id }));
      await waitForWaiterMatching(/requested_by_user_id|issuer_user_id/, 2);
      h3.release(); h4.release(); await h3.done; await h4.done;
      expect(await ec).toEqual({ ok: true });
      expect(await ed).toEqual({ ok: true });
    } finally { h3.release(); h4.release(); await Promise.allSettled([h3.done, h4.done]); }
    // #4811 F5: no deadlock happened (a serialization re-run under SERIALIZABLE is allowed, so the transaction count is not pinned).
    expect([cc.counter.deadlocks, cd.counter.deadlocks]).toEqual([0, 0]);
  });

  it('control: the same person erased twice at once: the first completes, the second refuses as not found, never erases twice', async () => {
    const S = await person('s');
    await signGrant(w.user2Id, S.id);
    const h = await holder('SELECT id FROM users WHERE id = $1 FOR UPDATE', S.id);
    const c1 = counting(); const c2 = counting();
    const e1 = settle(deleteUserAccount(c1.db, { targetUserId: S.id, actorUserId: S.id }));
    const e2 = settle(deleteUserAccount(c2.db, { targetUserId: S.id, actorUserId: S.id }));
    let results: Awaited<typeof e1>[];
    try {
      await waitForLockWaiters(db, 1);
      h.release(); await h.done;
      results = await Promise.all([e1, e2]);
    } finally { h.release(); await Promise.allSettled([h.done]); }
    expect(c1.counter.deadlocks + c2.counter.deadlocks).toBe(0); // #4811 F5: refused as not found, not retried as a deadlock
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok) as { ok: false; e: Error };
    expect(refused.e.message).toBe('User not found');
  });

  it('the counting client sees a plain erasure: one transaction, no deadlock (#4811 F7: a broken interception fails loudly)', async () => {
    const P = await person('p');
    const c = counting();
    await expect(deleteUserAccount(c.db, { targetUserId: P.id, actorUserId: P.id })).resolves.toBeUndefined();
    expect(c.counter).toEqual({ transactions: 1, deadlocks: 0 });
  });

  it('the deadlock retry does not widen isSerializationFailure for other callers (#4318)', () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError('deadlock detected', { code: 'P2010', clientVersion: 'test', meta: { code: '40P01' } });
    expect(isSerializationFailure(deadlock)).toBe(false);
  });
});
