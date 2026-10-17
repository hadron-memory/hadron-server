/** #1036: promised expiry applies before any reap; R5 chooses >=. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { isSessionLive, sessionLapsesAt, touchLiveSession } from '../../../lib/sessionActivity.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const S = resolvers.Session as any;
const expiry = new Date('2026-10-17T12:00:00.000Z');
const H = 3600000;
let holder: { id: string };
let other: { id: string };
let app: { id: string };
let worker: { id: string };
const ctx = (userId = holder.id): Context => ({ db, userId, roles: ['READER'] });
async function session(extra: Record<string, unknown> = {}) {
  return db.session.create({ data: {
    id: generateId(), appId: app.id, workerId: worker.id, userId: holder.id,
    type: 'DEVELOPER', startedAt: new Date(expiry.getTime() - H),
    updatedAt: new Date(expiry.getTime() - H), expiresAt: expiry, ...extra,
  } as never });
}
const post = (id: string, userId = holder.id) => M.createTeamChatMessage({}, { appRef: app.id, sessionRef: id, body: 'expiry pin' }, ctx(userId));
beforeEach(async () => {
  await cleanDb(db);
  holder = await db.user.create({ data: { githubId: 103601, githubUsername: 'expiry-holder' } });
  other = await db.user.create({ data: { githubId: 103602, githubUsername: 'expiry-other' } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'expiry', urn: `expiry-${generateId()}` } });
  for (const u of [holder, other]) await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'expiry', urn: `${org.urn}:a` } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'expiry', urn: `${org.urn}:agent` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { appId: app.id, agentId: agent.id, name: 'Expiry', slug: 'expiry', heldByUserId: holder.id } });
  // Fake Date only: database/network timers remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(expiry);
});
afterEach(() => vi.useRealTimers());

describe('#1036 no-reap hard expiry', () => {
  it.each([-1, 0, 1])('shared and narrow GraphQL reporting at expiry %+d ms', async (offset) => {
    const row = await session();
    vi.setSystemTime(expiry.getTime() + offset);
    const expected = offset < 0;
    expect(isSessionLive(row, null, new Date())).toBe(expected);
    expect(sessionLapsesAt(row, null)).toEqual(expiry);
    const c = ctx();
    expect(await S.isLive({ id: row.id }, {}, c)).toBe(expected);
    expect(await S.lapsesAt({ id: row.id }, {}, c)).toEqual(expiry);
  });
  it.each([0, 1])('post refuses at expiry %+d ms without heartbeat, resume, reap or hold release', async (offset) => {
    const row = await session();
    vi.setSystemTime(expiry.getTime() + offset);
    await expect(post(row.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_ENDED' }, message: expect.stringMatching(/expir.*start a new session/i) });
    const after = await db.session.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.updatedAt).toEqual(row.updatedAt);
    expect(after.endedAt).toBeNull();
    expect(after.autoExpiredAt).toBeNull();
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).heldByUserId).toBe(holder.id);
  });
  it('just before expiry a post succeeds', async () => {
    const row = await session();
    vi.setSystemTime(expiry.getTime() - 1);
    expect(await post(row.id)).toMatchObject({ sessionId: row.id });
  });
  it('hard expiry cannot resume through idle lapse', async () => {
    const row = await session({ startedAt: new Date(expiry.getTime() - 30 * H), updatedAt: new Date(expiry.getTime() - 30 * H) });
    await expect(post(row.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_ENDED' } });
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).updatedAt).toEqual(row.updatedAt);
  });
  it('heartbeat helper does not touch an expired row', async () => {
    const row = await session();
    await touchLiveSession(db, row.id);
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).updatedAt).toEqual(row.updatedAt);
  });
  it('no promise adds no expiry; idle lapse resumes but dormancy does not', async () => {
    const row = await session({ expiresAt: null, startedAt: new Date(expiry.getTime() - 30 * H), updatedAt: new Date(expiry.getTime() - 30 * H) });
    expect(await post(row.id)).toMatchObject({ sessionId: row.id });
    expect((await db.session.findUniqueOrThrow({ where: { id: row.id } })).expiresAt).toBeNull();
    await db.session.update({ where: { id: row.id }, data: { startedAt: new Date(expiry.getTime() - 91 * 24 * H), updatedAt: new Date(expiry.getTime() - 91 * 24 * H) } });
    await expect(post(row.id)).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_LIVE' }, message: expect.stringContaining('DORMANT') });
  });
  it('authorization precedes expiry diagnostics', async () => {
    const row = await session();
    await expect(post(row.id, other.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
  it.each([true, false])('ended refusal states only stored evidence (reaped=%s) and a no-force remedy', async (reaped) => {
    const row = await session({ expiresAt: null, endedAt: expiry, autoExpiredAt: reaped ? expiry : null, summary: 'superseded by somebody' });
    let error: any;
    try { await post(row.id); } catch (e) { error = e; }
    expect(error?.extensions.code).toBe('SESSION_ENDED');
    expect(error.message).toMatch(/start a new session/i);
    expect(error.message).not.toMatch(/--force|superseded by somebody/);
    expect(error.message).toMatch(reaped ? /auto-expired/ : /cause.*(?:unknown|not recorded)/i);
  });
});
