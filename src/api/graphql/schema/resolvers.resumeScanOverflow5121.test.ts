/**
 * #5121 — the resume scan's overflow refusal must not claim a live session it never checked
 * (cor:agt:020:11 rule 5: unknown is its own answer). It stays a refusal: a truncated set never resumes.
 * OTHER_SESSION_LIVE only when a SCANNED row is live; otherwise LIVENESS_UNKNOWN, after the ownership check.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { lapsedResumeDecision, tryResumeOwnLapsedSessionInTx } from '../../../lib/ownWorkerSessions.js';
import { OPEN_SESSION_SCAN_CAP } from '../../../lib/sessionActivity.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const H = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let app: { id: string };
let agentId: string;
let holder: { id: string };
let kit: { id: string };
let mine: { id: string; updatedAt: Date | null };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Overflow', urn: `overflow-${n}.example` }, select: { id: true, urn: true } });
  holder = await db.user.create({ data: { githubId: 51_000_000 + n, githubUsername: `ov-h-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(holder.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id }, select: { id: true } });
  mine = await db.session.create({
    data: { id: generateId(), appId: app.id, userId: holder.id, workerId: kit.id, agentId, startedAt: ago(43 * H), updatedAt: ago(43 * H) },
  });
});

/** Open rows the recently-touched filter admits and isSessionLive rejects: autoExpiredAt voids the heartbeat. */
const deadRows = (count: number) =>
  db.session.createMany({
    data: Array.from({ length: count }, () => ({
      id: generateId(), appId: app.id, userId: holder.id, workerId: kit.id, agentId, type: 'DEVELOPER' as const,
      startedAt: ago(48 * H), updatedAt: ago(60_000), autoExpiredAt: ago(30_000),
    })),
  });
/** A live row, placed first or last in the scan's `updatedAt desc` order. */
const liveRow = (updatedAt: Date) =>
  db.session.create({ data: { id: generateId(), appId: app.id, userId: holder.id, workerId: kit.id, agentId, startedAt: ago(72 * H), updatedAt } });

const inbox = () => Q.deliveryBatches({}, { appRef: app.id }, { ...ctx(holder.id), appId: app.id, sessionId: mine.id });
const underLock = () => db.$transaction((tx) => tryResumeOwnLapsedSessionInTx(ctx(holder.id), tx, mine.id));
const untouched = async () => {
  expect((await db.session.findUniqueOrThrow({ where: { id: mine.id } })).updatedAt).toEqual(mine.updatedAt);
  expect(await db.appLogEntry.count({ where: { sessionId: mine.id } })).toBe(0);
};
const inboxRefusal = async (): Promise<GraphQLError> => {
  try { await inbox(); } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError; }
  throw new Error('expected a refusal');
};

describe('#5121 an overflowed resume scan', () => {
  it('with no live row among the scanned ones refuses LIVENESS_UNKNOWN on the early check, and resumes nothing', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP + 1);
    const e = await inboxRefusal();
    expect(e.extensions).toEqual({ code: 'SESSION_NOT_LIVE', reason: 'LIVENESS_UNKNOWN' });
    expect(e.message).toBe('Session is not live and was not resumed (LIVENESS_UNKNOWN).');
    expect(await lapsedResumeDecision(ctx(holder.id), mine.id)).toEqual({ verdict: 'REFUSED', reason: 'LIVENESS_UNKNOWN' });
    await untouched();
  });

  it('refuses the same way under the Worker lock', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP + 1);
    expect(await underLock()).toBe('LIVENESS_UNKNOWN');
    await untouched();
  });

  it('still refuses, as unknown, when the only live row sits past the cap', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP + 1);
    await liveRow(ago(2 * 60_000)); // older updatedAt than every dead row: beyond the take
    expect(await underLock()).toBe('LIVENESS_UNKNOWN');
    await untouched();
  });

  it('says OTHER_SESSION_LIVE when a scanned row really is live', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP + 1);
    await liveRow(new Date());
    expect(await underLock()).toBe('OTHER_SESSION_LIVE');
    expect((await inboxRefusal()).extensions.reason).toBe('OTHER_SESSION_LIVE');
    await untouched();
  });

  it('control: exactly the cap of dead rows is not an overflow, and the session resumes', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP);
    expect(await underLock()).toBeNull();
  });

  it('control: ownership is judged first, so a caller who does not hold the worker gets NOT_OWNER', async () => {
    await deadRows(OPEN_SESSION_SCAN_CAP + 1);
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null } });
    expect(await underLock()).toBe('NOT_OWNER');
    expect(await lapsedResumeDecision(ctx(generateId()), mine.id)).toEqual({ verdict: 'REFUSED', reason: 'NOT_OWNER' });
  });
});
