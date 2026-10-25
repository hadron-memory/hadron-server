/** #1416 (R204): lifecycle schedules around a merge: inserted-during-wait, expiry crossing, actor-only writers. */
import { beforeEach, describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { lockAuthorityAnchors } from '../../lib/auth/authorityAnchors.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { mergeUsers } from './mergeUsers.js';

let org: { id: string; urn: string };
let source: { id: string };
let target: { id: string };
let other: { id: string };
let third: { id: string };
let admin: { id: string };

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = (id: string) => db.impersonationSession.findUniqueOrThrow({ where: { id } });
const startMerge = async () => mergeUsers(db, {
  sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id,
  consentProof: await approvedMergeProof(db, source.id, target.id, admin.id),
});
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};

/** Poll until some backend is blocked on an advisory lock: the competing operation has reached its wait. */
async function waitForAnchorWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    if (n > 0) return;
    await sleep(25);
  }
  throw new Error('no backend reached the anchor wait');
}

/** Hold the source's authority anchor on a second connection, run `inside`, then commit after `ms`. */
async function holdAnchor(mode: 'shared' | 'exclusive', inside: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>, ms: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const ready = new Promise<void>((r) => { locked = r; });
  const done = db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: source.id }], mode);
    await inside(tx);
    locked();
    await gate;
  });
  await ready;
  // `ms` is extra settling time on top of the observed wait (the expiry test needs wall-clock to pass).
  return { release, done, after: async () => {
    try { await waitForAnchorWaiter(); await sleep(ms); } finally { release(); await done; }
  } };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'race1416', urn: `race1416-${generateId()}.test` } });
  [source, target, other, third, admin] = await Promise.all(
    ['src', 'tgt', 'oth', 'thd', 'adm'].map((h) => db.user.create({ data: { handle: `${h}-${generateId().slice(-6)}`, ...(h === 'adm' ? { roles: ['ADMIN'] } : {}) } })),
  );
});

describe.each(['admin', 'target'] as const)('a start committed while the merge waits on the source anchor (source is the %s)', (role) => {
  it('is seen after the whole-transaction retry: ended, participant moved, not listed active', async () => {
    const id = generateId();
    const hold = await holdAnchor('shared', async (tx) => {
      await tx.impersonationSession.create({ data: {
        id, organizationId: org.id, expiresAt: new Date(Date.now() + HOUR),
        adminUserId: role === 'admin' ? source.id : other.id, targetUserId: role === 'admin' ? other.id : source.id,
      } });
    }, 50);
    const merging = startMerge();
    await hold.after();
    await merging;
    const row = await rowOf(id);
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(row.endedBy).toBeNull();
    expect(role === 'admin' ? row.adminUserId : row.targetUserId).toBe(target.id);
    expect(await db.impersonationSession.count({ where: { endedAt: null, expiresAt: { gt: new Date() } } })).toBe(0);
  });
});

describe('expiry crossing while the merge waits', () => {
  it('leaves a session that expired during the wait expired-unstamped, participants moved', async () => {
    const session = await db.impersonationSession.create({ data: {
      id: generateId(), organizationId: org.id, adminUserId: source.id, targetUserId: other.id, expiresAt: new Date(Date.now() + 700),
    } });
    const hold = await holdAnchor('shared', async () => {}, 1200);
    const merging = startMerge();
    await hold.after();
    await merging;
    expect(await rowOf(session.id)).toMatchObject({ adminUserId: target.id, endedAt: null, endedBy: null });
  });

  it('still ends a genuinely live session', async () => {
    const session = await db.impersonationSession.create({ data: {
      id: generateId(), organizationId: org.id, adminUserId: source.id, targetUserId: other.id, expiresAt: new Date(Date.now() + HOUR),
    } });
    const hold = await holdAnchor('shared', async () => {}, 300);
    const merging = startMerge();
    await hold.after();
    await merging;
    expect((await rowOf(session.id)).endedAt).toBeInstanceOf(Date);
  });
});

describe('actor-only writers around a merge', () => {
  const asSource = (): Context => ({ db, userId: source.id, roles: [] });
  const thirdPartySession = async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: source.id, role: 'ADMIN' } });
    return db.impersonationSession.create({ data: {
      id: generateId(), organizationId: org.id, adminUserId: other.id, targetUserId: third.id, expiresAt: new Date(Date.now() + HOUR),
    } });
  };

  it('a source stop before the merge is moved to the survivor', async () => {
    const s = await thirdPartySession();
    await resolvers.Mutation.stopImpersonation(null, { id: s.id }, asSource());
    expect((await rowOf(s.id)).endedBy).toBe(source.id);
    await startMerge();
    expect((await rowOf(s.id)).endedBy).toBe(target.id);
  });

  it('a source stop that arrives while the merge holds the anchor is refused, and never stamps the source', async () => {
    const s = await thirdPartySession();
    const hold = await holdAnchor('exclusive', async (tx) => {
      await tx.user.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
    }, 400);
    const stopping = codeOf(resolvers.Mutation.stopImpersonation(null, { id: s.id }, asSource()));
    await hold.after();
    expect(await stopping).not.toBe('NO_ERROR');
    expect((await rowOf(s.id)).endedBy).toBeNull();
    expect((await rowOf(s.id)).endedAt).toBeNull();
  });

  it('a source stop of a third party\'s session committed while the merge waits is moved to the survivor', async () => {
    const s = await thirdPartySession();
    const hold = await holdAnchor('shared', async (tx) => {
      await tx.impersonationSession.update({ where: { id: s.id }, data: { endedAt: new Date(), endedBy: source.id } });
    }, 50);
    const merging = startMerge();
    await hold.after();
    await merging;
    expect(await rowOf(s.id)).toMatchObject({ endedBy: target.id, adminUserId: other.id });
  });

  it('self-stop, a different stopper and an idempotent re-stop are unchanged', async () => {
    const s = await thirdPartySession();
    await db.orgMember.create({ data: { organizationId: org.id, userId: other.id, role: 'ADMIN' } });
    const byOther: Context = { db, userId: other.id, roles: [] };
    await resolvers.Mutation.stopImpersonation(null, { id: s.id }, byOther);
    await resolvers.Mutation.stopImpersonation(null, { id: s.id }, asSource());
    expect((await rowOf(s.id)).endedBy).toBe(other.id);
  });
});

describe('the platform-key stop fallback ender', () => {
  it('is coordinated with the merge: a fallback ender merged away before the write is refused, never stamped', async () => {
    const session = await db.impersonationSession.create({ data: {
      id: generateId(), organizationId: org.id, adminUserId: source.id, targetUserId: other.id,
      expiresAt: new Date(Date.now() - 1000), // expired-unstamped: the history a merge leaves unstamped
    } });
    const hold = await holdAnchor('exclusive', async (tx) => {
      await tx.user.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
    }, 50);
    const stopping = codeOf(resolvers.Mutation.stopImpersonation(null, { id: session.id }, { db, roles: ['ADMIN'] }));
    await hold.after();
    expect(await stopping).not.toBe('NO_ERROR');
    expect(await rowOf(session.id)).toMatchObject({ endedAt: null, endedBy: null });
  });

  it('still records the session admin as ender when it is live', async () => {
    const session = await db.impersonationSession.create({ data: {
      id: generateId(), organizationId: org.id, adminUserId: other.id, targetUserId: third.id, expiresAt: new Date(Date.now() + HOUR),
    } });
    await resolvers.Mutation.stopImpersonation(null, { id: session.id }, { db, roles: ['ADMIN'] });
    expect(await rowOf(session.id)).toMatchObject({ endedBy: other.id });
    expect((await rowOf(session.id)).endedAt).toBeInstanceOf(Date);
  });
});

describe('retirement around a merge', () => {
  const setup = async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: source.id, role: 'ADMIN' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Wy', slug: 'wy' } });
    return worker;
  };
  const retireAsSource = (workerId: string) => resolvers.Mutation.retireWorker(null, { workerRef: workerId }, { db, userId: source.id, roles: [] });

  it('a retirement before the merge is moved to the survivor', async () => {
    const worker = await setup();
    await retireAsSource(worker.id);
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).retiredBy).toBe(source.id);
    await startMerge();
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).retiredBy).toBe(target.id);
  });

  it('a retirement committed while the merge waits is moved to the survivor', async () => {
    const worker = await setup();
    const hold = await holdAnchor('shared', async (tx) => {
      await tx.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date(), retiredBy: source.id } });
    }, 50);
    const merging = startMerge();
    await hold.after();
    await merging;
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).retiredBy).toBe(target.id);
  });

  it('a retirer whose staff role was revoked while it waited is refused, though still a live user', async () => {
    const worker = await setup();
    const hold = await holdAnchor('exclusive', async (tx) => {
      await tx.orgMember.updateMany({ where: { organizationId: org.id, userId: source.id }, data: { role: 'READER' } });
    }, 50);
    const retiring = codeOf(retireAsSource(worker.id));
    await hold.after();
    expect(await retiring).not.toBe('NO_ERROR');
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ retiredAt: null, retiredBy: null });
  });

  it('a retirement that arrives while the merge holds the anchor is refused and stamps nothing', async () => {
    const worker = await setup();
    const hold = await holdAnchor('exclusive', async (tx) => {
      await tx.user.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
    }, 400);
    const retiring = codeOf(retireAsSource(worker.id));
    await hold.after();
    expect(await retiring).not.toBe('NO_ERROR');
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ retiredAt: null, retiredBy: null });
  });
});
