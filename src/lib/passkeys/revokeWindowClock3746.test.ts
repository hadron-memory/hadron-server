/**
 * #3746 (cor:aut:040:07, 040:08): a revocation counts as in a first passkey's window only if it takes effect before
 * `window_ends_at`. Nothing is cancelled retroactively: a revoke whose waits carry it past the boundary either revokes
 * without cancelling, at a truthful time, or refuses; a cancel link past the boundary revokes nothing.
 *
 * Every pin runs with the passkey guard and CHECK enabled. The closing window comes from the platform clock seam
 * (`public.hadron_passkey_clock_offset()`), replaced only inside the one fixture transaction that registers the passkey, so
 * the passkey is registered "72 hours minus a moment" ago by the guard's own clock.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey, type SoftPasskey } from '../../test/softPasskey.js';
import { generateId } from '../id.js';
import { createSignIn } from '../../auth/signIn.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { deriveSignatureState } from '../signing/state.js';
import { createCeremony } from './ceremony.js';
import { cancelFirstPasskey, issueCancelToken } from './cancel.js';
import { bindRevokeByPasskey, finishRevoke } from './revoke.js';

const RP = 'example.test';
const ORIGIN = 'https://sign.example.test';
const h = (v: string) => createHash('sha256').update(v).digest('hex');
const C = 'clock-ceremony-cookie';
const WINDOW_MS = 72 * 3600 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ana: string;
let phone: SoftPasskey; let phoneId: string;
let first: SoftPasskey; let firstId: string;

const setOffset = (tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>, ms: number) => {
  if (!Number.isSafeInteger(ms)) throw new Error('offset must be an integer');
  return tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE
    AS $$ SELECT interval '${ms} milliseconds' $$`);
};

/** A first passkey whose 72-hour window ends `msToEnd` from now, registered through the guard's own clock. */
async function insertClosingFirstPasskey(ownerId: string, key: SoftPasskey, msToEnd: number): Promise<string> {
  const id = generateId();
  await db.$transaction(async (tx) => {
    await setOffset(tx, -(WINDOW_MS - msToEnd));
    await tx.$executeRaw`INSERT INTO passkey_credentials
      (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports,
       backup_eligible, backed_up, registration_method, window_ends_at)
      VALUES (${id}, ${ownerId}, ${key.credentialId}, ${key.cosePublicKey}, -7, ${Buffer.alloc(32, 7)}, ${RP}, 'Closing',
        public.hadron_passkey_now(), 0, ARRAY['internal'], false, false, 'github', public.hadron_passkey_now() + interval '72 hours')`;
    await setOffset(tx, 0);
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_RP_ID', RP);
  ana = (await db.user.create({ data: { handle: 'clk-ana', roles: [] } })).id;
  phone = softPasskey(); phoneId = await insertSoftPasskey(db, ana, phone, { label: 'Phone' });
  first = softPasskey();
});

const ceremony = async () =>
  (await db.$transaction((tx) => createCeremony(tx, { purpose: 'REVOKE', browserNonceHash: h(C), ttlSeconds: 300, challengeIsId: true }))).id;
async function proved(): Promise<string> {
  const id = await ceremony();
  const a = phone.assert({ payload: Buffer.alloc(0), rawChallenge: Buffer.from(id, 'base64url'), origin: ORIGIN, rpId: RP, counter: 1 });
  const b = await bindRevokeByPasskey(db, { ceremonyId: id, ceremonyNonceHash: h(C), proof: { credentialId: phone.credentialId, ...a }, rpId: RP, origins: [ORIGIN] });
  expect(b?.userId).toBe(ana);
  return id;
}
const finish = (id: string) =>
  finishRevoke(db, { ceremonyId: id, ceremonyNonceHash: h(C), signInBrowserHash: null, targetCredentialId: first.credentialId });
const rec = (id: string) => db.passkeyCredential.findUniqueOrThrow({ where: { id } });
const consumedAt = async (id: string) => (await db.passkeyCeremony.findUniqueOrThrow({ where: { id } })).consumedAt;
const tokenUsedAt = async (passkeyId: string) =>
  (await db.$queryRaw<Array<{ used_at: Date | null }>>`SELECT used_at FROM passkey_cancel_tokens WHERE passkey_id = ${passkeyId}`)[0].used_at;
const dbNow = async () => (await db.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now`)[0].now;

/** A transaction that runs `body`, reports its backend pid, and holds what it locked until released. */
function holder(body: (tx: Prisma.TransactionClient) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: (pid: number) => void;
  const pidReady = new Promise<number>((r) => { ready = r; });
  const done = db.$transaction(async (tx) => {
    await body(tx);
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(pid);
    await gate;
  }, { timeout: 30_000 });
  return { pid: Promise.race([pidReady, done.then(() => { throw new Error('holder ended before locking'); })]), release, done };
}
const holdAnchor = () => holder(async (tx) => { await lockAuthorityAnchors(tx, [{ kind: 'user', id: ana }], 'exclusive'); });
const holdSignIn = (signInId: string) => holder(async (tx) => { await tx.$queryRaw`SELECT id FROM sign_ins WHERE id = ${signInId} FOR UPDATE`; });

/** Wait until `n` backends are blocked by `pid` (so the waiters provably reached the lock); returns the count seen. */
async function blockedBy(pid: number, n: number): Promise<number> {
  let seen = 0;
  for (let i = 0; i < 300 && seen < n; i++) {
    const [{ c }] = await db.$queryRaw<Array<{ c: bigint }>>`SELECT count(*) AS c FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    seen = Number(c);
    if (seen < n) await sleep(20);
  }
  return seen;
}
/** Wait until the database clock has passed the passkey's window end. */
async function pastWindow(passkeyId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [{ past }] = await db.$queryRaw<Array<{ past: boolean }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') > window_ends_at AS past
      FROM passkey_credentials WHERE id = ${passkeyId}`;
    if (past) return;
    await sleep(20);
  }
  throw new Error('window never ended');
}

/**
 * Run `waiter` behind `held`, release `held` once `until` resolves (by default: the window has ended), and return the
 * waiter's result with `heldUntil`, the database clock read just before the release: the waiter can take effect no
 * earlier than that (Jane's lower bound, #3761 F1).
 */
async function crossWhileHeld<T>(held: ReturnType<typeof holder>, waiter: () => Promise<T>, until: () => Promise<unknown> = () => pastWindow(firstId)) {
  let run: Promise<T> | undefined;
  let heldUntil!: Date;
  try {
    const pid = await held.pid;
    run = waiter();
    expect(await blockedBy(pid, 1)).toBe(1);
    await until();
    heldUntil = await dbNow();
  } finally {
    held.release();
    await held.done;
  }
  return { result: await run!, heldUntil };
}
/** Backends waiting for the owner's authority anchor (ungranted advisory locks on its key). */
async function anchorWaiters(n: number): Promise<number> {
  let seen = 0;
  for (let i = 0; i < 300 && seen < n; i++) {
    const [{ c }] = await db.$queryRaw<Array<{ c: bigint }>>`SELECT count(*) AS c FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = hashtext('authorization:user')::oid AND objid = hashtext(${ana})::oid`;
    seen = Number(c);
    if (seen < n) await sleep(20);
  }
  return seen;
}

const signatureControl = async (passkeyId: string) => {
  const r = await rec(passkeyId);
  return deriveSignatureState({
    verifiedAt: new Date(r.registeredAt.getTime() + 1000), valid: true, contentChangedAt: null, memoryEncrypted: false, now: await dbNow(),
    passkey: { revokedAt: r.revokedAt, windowEndsAt: r.windowEndsAt, windowEndedAt: r.windowEndedAt, windowOutcome: r.windowOutcome },
  });
};
const expectRevokedAfterWindow = async (passkeyId: string) => {
  const r = await rec(passkeyId);
  expect(r.revokedAt).not.toBeNull();
  expect(r.revokedAt!.getTime()).toBeGreaterThanOrEqual(r.windowEndsAt!.getTime());
  expect(r.windowOutcome).not.toBe('cancelled');
  expect(r.cancelledAt).toBeNull();
  expect(await signatureControl(passkeyId)).toBe('CURRENT');
};

describe('an ordinary revoke whose waits cross the window end revokes without cancelling, at a truthful time', () => {
  it('crossing during the anchor wait', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const id = await proved();
    const { result, heldUntil } = await crossWhileHeld(holdAnchor(), () => finish(id));
    expect(result).toEqual({ passkeyId: firstId, windowCancelled: false });
    await expectRevokedAfterWindow(firstId);
    expect((await rec(firstId)).revokedAt!.getTime()).toBeGreaterThanOrEqual(heldUntil.getTime());
  }, 20_000);

  it('crossing while ending the passkey\'s sign-ins', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const signIn = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: firstId }));
    const id = await proved();
    const { result } = await crossWhileHeld(holdSignIn(signIn.id), () => finish(id));
    expect(result).toEqual({ passkeyId: firstId, windowCancelled: false });
    await expectRevokedAfterWindow(firstId);
    expect((await db.signIn.findUniqueOrThrow({ where: { id: signIn.id } })).endedAt).not.toBeNull();
  }, 20_000);

  it('a revoke that takes effect before the window end cancels it, stamped when it takes effect (not before its wait)', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 20_000);
    const id = await proved();
    const { result, heldUntil } = await crossWhileHeld(holdAnchor(), () => finish(id), () => sleep(300));
    expect(result).toEqual({ passkeyId: firstId, windowCancelled: true });
    const r = await rec(firstId);
    expect(r.revokedAt!.getTime()).toBeGreaterThanOrEqual(heldUntil.getTime());
    expect(r.windowOutcome).toBe('cancelled');
    expect(r.revokedAt!.getTime()).toBeLessThan(r.windowEndsAt!.getTime());
    expect(r.windowEndedAt?.getTime()).toBe(r.revokedAt?.getTime());
    expect(await signatureControl(firstId)).toBe('CANCELLED');
  }, 20_000);
});

describe('a cancel link past the window end revokes nothing', () => {
  const req = { ip: '203.0.113.9', userAgent: 'clock-test' };

  it('control: crossing during the anchor wait', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const token = await db.$transaction((tx) => issueCancelToken(tx, firstId));
    expect((await crossWhileHeld(holdAnchor(), () => cancelFirstPasskey(db, { token, ...req }))).result).toBe(false);
    expect((await rec(firstId)).revokedAt).toBeNull();
    expect(await tokenUsedAt(firstId)).toBeNull();
  }, 20_000);

  it('a cancel inside the window is stamped when it takes effect, not before its wait', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 20_000);
    const token = await db.$transaction((tx) => issueCancelToken(tx, firstId));
    const { result, heldUntil } = await crossWhileHeld(holdAnchor(), () => cancelFirstPasskey(db, { token, ...req }), () => sleep(300));
    expect(result).toBe(true);
    const r = await rec(firstId);
    expect(r.cancelledAt!.getTime()).toBeGreaterThanOrEqual(heldUntil.getTime());
    expect(r.revokedAt?.getTime()).toBe(r.cancelledAt?.getTime());
    expect(r.cancelledAt!.getTime()).toBeLessThan(r.windowEndsAt!.getTime());
  }, 20_000);

  it('crossing while ending the passkey\'s sign-ins', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const token = await db.$transaction((tx) => issueCancelToken(tx, firstId));
    const signIn = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: firstId }));
    expect((await crossWhileHeld(holdSignIn(signIn.id), () => cancelFirstPasskey(db, { token, ...req }))).result).toBe(false);
    const r = await rec(firstId);
    expect(r.revokedAt).toBeNull();
    expect(r.windowOutcome).toBeNull();
    expect(await tokenUsedAt(firstId)).toBeNull();
    expect((await db.signIn.findUniqueOrThrow({ where: { id: signIn.id } })).endedAt).toBeNull();
  }, 20_000);
});

describe('the second attempt re-decides from what is true then', () => {
  /**
   * The finish (B) takes the anchor, stamps inside the window and parks on the passkey's sign-in (held by S), still
   * holding the anchor; `change` (C) then queues on the anchor behind it. S is released after the window end, so B's
   * first attempt fails its final check and rolls back, C runs, and B's retry starts after C commits.
   */
  async function crossThenChange(id: string, change: (tx: Prisma.TransactionClient) => Promise<void>) {
    const signIn = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: firstId }));
    const s = holdSignIn(signIn.id);
    let b: ReturnType<typeof finish> | undefined;
    let c: Promise<unknown> | undefined;
    try {
      const pid = await s.pid;
      b = finish(id);
      expect(await blockedBy(pid, 1)).toBe(1);
      c = db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'user', id: ana }], 'exclusive');
        await change(tx);
      }, { timeout: 30_000 });
      expect(await anchorWaiters(1)).toBe(1);
      await pastWindow(firstId);
    } finally {
      s.release();
      await s.done;
    }
    await c;
    return b!;
  }
  const expectNothingChanged = async (id: string) => {
    expect((await rec(firstId)).revokedAt).toBeNull();
    expect((await rec(firstId)).windowOutcome).toBeNull();
    expect(await consumedAt(id)).toBeNull();
  };

  it('a prover revoked between the attempts refuses the retry', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const id = await proved();
    const result = await crossThenChange(id, async (tx) => {
      await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_now() WHERE id = ${phoneId}`;
    });
    expect(result).toBeNull();
    await expectNothingChanged(id);
  }, 20_000);

  it('a ceremony expired between the attempts refuses the retry', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const id = await proved();
    const result = await crossThenChange(id, async (tx) => {
      await tx.$executeRaw`UPDATE passkey_ceremonies SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = ${id}`;
    });
    expect(result).toBeNull();
    await expectNothingChanged(id);
  }, 20_000);

  it('a ceremony consumed between the attempts (by a finish for another passkey) refuses the retry (Rook P3-1)', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const tablet = softPasskey(); const tabletId = await insertSoftPasskey(db, ana, tablet, { label: 'Tablet' });
    const id = await proved();
    let other: Promise<unknown> | undefined;
    const signIn = await db.$transaction((tx) => createSignIn(tx, { userId: ana, method: 'email', passkeyId: firstId }));
    const s = holdSignIn(signIn.id);
    let b: ReturnType<typeof finish> | undefined;
    try {
      const pid = await s.pid;
      b = finish(id);
      expect(await blockedBy(pid, 1)).toBe(1);
      other = finishRevoke(db, { ceremonyId: id, ceremonyNonceHash: h(C), signInBrowserHash: null, targetCredentialId: tablet.credentialId });
      expect(await anchorWaiters(1)).toBe(1);
      await pastWindow(firstId);
    } finally {
      s.release();
      await s.done;
    }
    expect(await other).toEqual({ passkeyId: tabletId, windowCancelled: false });
    expect(await b!).toBeNull();
    expect((await rec(firstId)).revokedAt).toBeNull();
    expect((await rec(tabletId)).revokedAt).not.toBeNull();
  }, 20_000);

  it('a retry that would again cancel (the platform clock stepped back) fails closed', async () => {
    firstId = await insertClosingFirstPasskey(ana, first, 1500);
    const id = await proved();
    try {
      const result = await crossThenChange(id, async (tx) => { await setOffset(tx, -60_000); });
      expect(result).toBeNull();
    } finally {
      await setOffset(db, 0);
    }
    await expectNothingChanged(id);
  }, 20_000);
});

describe('the passkey guard accepts a lifecycle stamp from the transaction start up to the wall clock at the write', () => {
  const refused = (sql: Prisma.Sql) => expect(db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_sleep(0.05)`;
    await tx.$executeRaw(sql);
  })).rejects.toThrow(/platform clock/);

  it('accepts the wall clock after a wait, and refuses a stamp before the transaction or in the future', async () => {
    const a = softPasskey(); const aId = await insertSoftPasskey(db, ana, a, { firstWindow: true });
    await refused(Prisma.sql`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_now() - interval '1 millisecond' WHERE id = ${aId}`);
    await refused(Prisma.sql`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_wall_now() + interval '1 second' WHERE id = ${aId}`);
    await refused(Prisma.sql`WITH t AS (SELECT public.hadron_passkey_wall_now() AS at) UPDATE passkey_credentials SET revoked_at = t.at,
      window_ended_at = t.at - interval '1 hour', window_outcome = 'ended-early' FROM t WHERE id = ${aId}`);
    await refused(Prisma.sql`WITH t AS (SELECT public.hadron_passkey_wall_now() AS at) UPDATE passkey_credentials SET revoked_at = t.at,
      cancelled_at = t.at + interval '1 second', window_ended_at = t.at, window_outcome = 'cancelled', cancel_ip = 'x', cancel_user_agent = 'y'
      FROM t WHERE id = ${aId}`);
    expect((await rec(aId)).revokedAt).toBeNull();
    const at = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.05)`;
      const [row] = await tx.$queryRaw<Array<{ revoked_at: Date; started: Date }>>`WITH t AS (SELECT public.hadron_passkey_wall_now() AS at)
        UPDATE passkey_credentials SET revoked_at = t.at, window_ended_at = t.at, window_outcome = 'cancelled'
        FROM t WHERE id = ${aId} RETURNING revoked_at, public.hadron_passkey_now() AS started`;
      return row;
    });
    expect(at.revoked_at.getTime()).toBeGreaterThan(at.started.getTime());
  });
});

describe('the guard\'s clock is the public one, whatever the session\'s search_path (#3761 blind P2)', () => {
  it('a schema earlier on the search_path with its own clock offset moves nothing', async () => {
    await db.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS shadow3761');
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION shadow3761.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE
      AS $$ SELECT interval '-1 day' $$`);
    try {
      const k = softPasskey();
      const insert = (tx: Prisma.TransactionClient, at: Prisma.Sql) => tx.$executeRaw`INSERT INTO passkey_credentials
        (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up)
        VALUES (${generateId()}, ${ana}, ${k.credentialId}, ${k.cosePublicKey}, -7, ${Buffer.alloc(32, 9)}, ${RP}, 'Shadow', ${at}, 0, ARRAY['internal'], false, false)`;
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = shadow3761, public');
        await insert(tx, Prisma.sql`((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 day')::timestamp(3)`);
      })).rejects.toThrow(/platform clock/);
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = shadow3761, public');
        await insert(tx, Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)`);
      });
    } finally {
      await db.$executeRawUnsafe('DROP SCHEMA shadow3761 CASCADE');
    }
  });
});
