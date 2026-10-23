import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1926 — an App's stall schedule on the MCP surface: hadron_stall_schedule_get
 * and hadron_stall_schedule_set. The rules (the bounds, the manager gate, omitted
 * keeps, null resets) are pinned against the resolvers in
 * resolvers.agentTaskAlarms.test.ts; this covers the SURFACE: both tools are
 * thin calls into those resolvers, so a refusal's code and message are the
 * GraphQL ones, all seven values travel, an omitted field is never forwarded
 * (keeps) while an explicit null is (resets), and no principal the resolver
 * refuses is admitted by the transport (cor:agt:050:14–:17, :10, 070:01, :02).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey, type AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let agentId: string;
let anne: { id: string };
let appKeyId: string;

const authOf = (userId: string, extra: Partial<AuthContext> = {}) =>
  ({ userId, roles: ['READER'], clientId: `user:${userId}`, ...extra }) as AuthContext;
const mcp = (auth: AuthContext) =>
  createTestableMcpServer(auth, { sessionId: `ss-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function session(data: { userId?: string; appId?: string; workerId?: string }) {
  return db.session.create({
    data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) },
    select: { id: true },
  });
}

/** The GraphQL refusal for the same input, as `[code] message`, to hold the MCP text against. */
async function graphqlRefusal(call: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call();
  } catch (e: any) {
    return { code: String(e.extensions?.code), message: e.message };
  }
  throw new Error('expected the GraphQL call to be refused');
}

const row = () => db.agentTaskStallSchedule.findUnique({ where: { appId: app.id } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Stall MCP', urn: `stallmcp-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `ss-admin-${n}`, roles: [] } });
  member = await db.user.create({ data: { githubId: 1_000_000 + n, githubUsername: `ss-member-${n}`, roles: [] } });
  outsider = await db.user.create({ data: { githubId: 1_100_000 + n, githubUsername: `ss-out-${n}`, roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `stallmcp-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Anne', slug: 'anne', heldByUserId: admin.id }, select: { id: true } });
  const raw = `${APP_KEY_PREFIX}${generateId()}`;
  appKeyId = (await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label: 'k' } })).id;
});

describe('registration', () => {
  it('lists the get and set tools, and the set tool requires a session like every write', async () => {
    const s = mcp(authOf(member.id));
    expect(s.toolDescription('hadron_stall_schedule_get')).toMatch(/stall/i);
    expect(s.toolDescription('hadron_stall_schedule_set')).toMatch(/manages the App/);
    expect(code(text(await s.callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 45 })))).toBe('SESSION_REQUIRED');
    expect(await row()).toBeNull();
  });
});

describe('hadron_stall_schedule_get', () => {
  it('renders all seven effective values with their defaults and no updatedAt for an untouched App', async () => {
    const t = text(await mcp(authOf(member.id)).callTool('hadron_stall_schedule_get', { appRef: app.id }));
    for (const line of [
      'notStartedMinutes: 15', 'noProgressMinutes: 60', 'ownerReactionMinutes: 20', 'assignmentMinutes: 30',
      'hostLapseCheckIns: 3', 'sessionEndGraceMinutes: 10', 'hostReportTimeoutMinutes: ',
    ]) expect(t).toContain(line);
    expect(t).toMatch(/updatedAt: never/);
  });

  it('a non-participant is refused exactly as GraphQL refuses, and nothing is created', async () => {
    const t = text(await mcp(authOf(outsider.id)).callTool('hadron_stall_schedule_get', { appRef: app.id }));
    const gql = await graphqlRefusal(() => Q.agentTaskStallSchedule({}, { appRef: app.id }, ctx(outsider.id)));
    expect(code(t)).toBe(gql.code);
    expect(t).toContain(gql.message);
    expect(await row()).toBeNull();
  });

  it('an App key is judged by the resolver, not widened by the tool being actor-neutral', async () => {
    const key = authOf(undefined as never, { userId: undefined, appId: app.id, appKeyId, clientId: undefined } as never);
    const t = text(await mcp(key).callTool('hadron_stall_schedule_get', { appRef: app.id }));
    const gql = await graphqlRefusal(() => Q.agentTaskStallSchedule({}, { appRef: app.id }, { db, appId: app.id, appKeyId, roles: [] } as Context));
    expect(code(t)).toBe(gql.code);
  });
});

describe('hadron_stall_schedule_set', () => {
  const all = {
    notStartedMinutes: 11, noProgressMinutes: 45, ownerReactionMinutes: 12, assignmentMinutes: 33,
    hostLapseCheckIns: 5, sessionEndGraceMinutes: 90, hostReportTimeoutMinutes: 20,
  };

  it('a manager sets all seven values, and a get shows exactly those', async () => {
    const plain = await session({ userId: admin.id });
    const s = mcp(authOf(admin.id));
    const set = text(await s.callTool('hadron_stall_schedule_set', { appRef: app.id, ...all, session: plain.id }));
    expect(set).toMatch(/^Set\./);
    for (const [k, v] of Object.entries(all)) expect(set).toContain(`${k}: ${v}`);
    expect(await row()).toMatchObject(all);
    const got = text(await mcp(authOf(member.id)).callTool('hadron_stall_schedule_get', { appRef: app.id }));
    for (const [k, v] of Object.entries(all)) expect(got).toContain(`${k}: ${v}`);
    expect(got).not.toMatch(/updatedAt: never/);
  });

  it('an omitted field keeps its value; an explicit null restores that one default only', async () => {
    const plain = await session({ userId: admin.id });
    const s = mcp(authOf(admin.id));
    await s.callTool('hadron_stall_schedule_set', { appRef: app.id, ...all, session: plain.id });
    await s.callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 70, session: plain.id });
    expect(await row()).toMatchObject({ ...all, noProgressMinutes: 70 });
    const out = text(await s.callTool('hadron_stall_schedule_set', { appRef: app.id, hostLapseCheckIns: null, session: plain.id }));
    expect(out).toContain('hostLapseCheckIns: 3');
    expect(await row()).toMatchObject({ ...all, noProgressMinutes: 70, hostLapseCheckIns: null });
  });

  it('out-of-range values are the server\'s refusal, byte for byte, and write nothing', async () => {
    const plain = await session({ userId: admin.id });
    const s = mcp(authOf(admin.id));
    const cases: Array<[string, number]> = [
      ['noProgressMinutes', 0], ['assignmentMinutes', 10_081], ['hostLapseCheckIns', 1], ['hostLapseCheckIns', 11],
      ['sessionEndGraceMinutes', 0], ['sessionEndGraceMinutes', 1441], ['hostReportTimeoutMinutes', 0],
    ];
    for (const [field, v] of cases) {
      const t = text(await s.callTool('hadron_stall_schedule_set', { appRef: app.id, [field]: v, session: plain.id }));
      const gql = await graphqlRefusal(() => M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { [field]: v } }, ctx(admin.id)));
      expect({ field, v, code: code(t) }).toEqual({ field, v, code: gql.code });
      expect(t).toContain(gql.message);
    }
    expect(await row()).toBeNull();
  });

  it('a member, a bound worker (even one its manager holds), and a non-participant are refused as GraphQL refuses; the row is unchanged', async () => {
    const adminPlain = await session({ userId: admin.id });
    await mcp(authOf(admin.id)).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 45, session: adminPlain.id });
    const before = await row();

    const memberPlain = await session({ userId: member.id });
    const asMember = text(await mcp(authOf(member.id)).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 5, session: memberPlain.id }));
    const gql = await graphqlRefusal(() => M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { noProgressMinutes: 5 } }, ctx(member.id)));
    expect(code(asMember)).toBe('APP_MANAGER_REQUIRED');
    expect(asMember).toContain(gql.message);

    const asAnne = await session({ userId: admin.id, appId: app.id, workerId: anne.id });
    const asWorker = text(await mcp(authOf(admin.id)).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 5, session: asAnne.id }));
    expect(code(asWorker)).toBe('APP_MANAGER_REQUIRED');

    const outsiderPlain = await session({ userId: outsider.id });
    const asOutsider = text(await mcp(authOf(outsider.id)).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 5, session: outsiderPlain.id }));
    expect(code(asOutsider)).toBe('APP_NOT_FOUND');

    expect(await row()).toEqual(before);
  });

  it('an impersonation principal and an App key do not manage the App through this transport; the row is unchanged', async () => {
    const plain = await session({ userId: admin.id });
    const imp = authOf(admin.id, { impersonation: { sessionId: 's', actorUserId: admin.id, orgId: 'o', expiresAt: new Date('2099-01-01') } } as never);
    const asImp = text(await mcp(imp).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 5, session: plain.id }));
    expect(['APP_MANAGER_REQUIRED', 'SESSION_NOT_BOUND', 'APP_NOT_FOUND']).toContain(code(asImp));
    expect(code(asImp)).not.toBe('NO_ERROR');

    const key = authOf(undefined as never, { userId: undefined, appId: app.id, appKeyId, clientId: undefined } as never);
    const asKey = text(await mcp(key).callTool('hadron_stall_schedule_set', { appRef: app.id, noProgressMinutes: 5, session: plain.id }));
    expect(code(asKey)).not.toBe('NO_ERROR');
    expect(await row()).toBeNull();
  });
});
