import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #3078 (cor:agt:020:11, cor:agt:020:05, cor:api:240): a worker's `recordTeamWork` of ANY kind, through a session its
 * caller drives, counts as driving that session — through the same heartbeat the roster, `worker get` and the bind
 * gate read (`touchSessionIfLive`), exactly as MCP `hadron_record_work` already does via `heartbeatSession`. Before
 * this, GraphQL touched the Session row only for `kind: "pr"` (the `prNumber` denormalization), so a worker whose only
 * activity was CLI `session log` of non-PR work read NO_SESSION after one idle window (part of #2694).
 *
 * Fences (the issue's acceptance 2, 3): a lapsed or ended session is never revived (#1543; late attribution stays
 * allowed, cor:agt:020:05); a session the caller does not drive is never touched — the platform-admin branch of the
 * session write gate admits the RECORD but not the heartbeat, matching MCP's `{ userId: auth.userId }` scoping;
 * impersonation and a caller removed from the App record nothing and touch nothing.
 *
 * Parity (acceptance 4, the gate's decision): MCP `heartbeatSession` stays as it is, and a differential runs every
 * fixture through both surfaces and requires the same liveness outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { loadWorkerCheckStatuses } from '../../../lib/workerCheckStatus.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

let org: { id: string; urn: string };
let app: { id: string };
let teamAgent: { id: string };
let member: { id: string };
let other: { id: string };
let removed: { id: string };
let platformAdmin: { id: string };
let anne: { id: string };
let liam: { id: string };
let rex: { id: string };

const REFS: Record<string, string> = { pr: 'o/r#371', issue: 'o/r#5', commit: 'o/r@abc1234', branch: 'o/r:feat/x', repo: 'o/r' };

const session = (worker: { id: string } | null, userId: string, hoursSilent: number, endedHoursAgo?: number) =>
  db.session.create({
    data: {
      id: generateId(), appId: app.id, workerId: worker?.id ?? null, agentId: teamAgent.id, userId,
      startedAt: ago(hoursSilent), updatedAt: ago(hoursSilent),
      ...(endedHoursAgo != null ? { endedAt: ago(endedHoursAgo) } : {}),
    },
    select: { id: true },
  });
const heartbeat = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id } })).updatedAt!.getTime();

const gqlCtx = (userId: string, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], ...extra }) as Context;
const recordGql = (c: Context, sessionRef: string, kind = 'issue') =>
  M.recordTeamWork({}, { appRef: app.id, sessionRef, tool: 'github', kind, ref: REFS[kind], action: 'opened' }, c);

const mcpAuth = (userId: string, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ userId, appId: app.id, roles: ['READER'], clientId: `user:${userId}`, ...extra }) as AuthContext;
const recordMcp = (a: AuthContext, sessionRef: string, kind = 'issue') =>
  createTestableMcpServer(a).callToolText('hadron_record_work', {
    session: sessionRef, app: app.id, tool: 'github', kind, ref: REFS[kind], action: 'opened',
  });

const impersonating = () => ({ sessionId: generateId(), actorUserId: platformAdmin.id, orgId: org.id, expiresAt: new Date(Date.now() + HOUR) });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'tw3078-org', urn: `tw3078-${n}.example` } });
  const orgAdmin = await db.user.create({ data: { id: generateId(), githubId: 307_800_000 + n, githubUsername: `tw3078-oa-${n}`, roles: ['READER'] } });
  const user = (tag: string, i: number, roles: string[] = ['READER']) =>
    db.user.create({ data: { id: generateId(), githubId: 307_810_000 + i * 1_000_000 + n, githubUsername: `tw3078-${tag}-${n}`, roles: roles as never }, select: { id: true } });
  member = await user('mia', 1);
  other = await user('oli', 2);
  removed = await user('rem', 3);
  platformAdmin = await user('pad', 4, ['ADMIN']);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: orgAdmin.id, roles: ['READER'] });
  teamAgent = { id: created.id };
  // The worklog's first write bootstraps through the App's Team Agent, inferred from a roles: branch (#947).
  await db.node.create({ data: { id: generateId(), memoryId: created.systemMemoryId, loc: 'roles:server-engineer', name: 'server-engineer', content: 'You are {{worker.name}}.' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  for (const u of [member, other, removed, platformAdmin]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  const worker = (name: string, heldBy: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: teamAgent.id, name, slug: name.toLowerCase(), heldByUserId: heldBy }, select: { id: true } });
  anne = await worker('Anne', member.id);
  liam = await worker('Liam', other.id);
  rex = await worker('Rex', removed.id);
});

describe('#3078 acceptance 1: a worker\'s recordTeamWork through its own live session drives it', () => {
  it.each(['issue', 'commit', 'branch', 'repo'])('kind %s advances the heartbeat of a live session driven 20h ago', async (kind) => {
    const s = await session(anne, member.id, 20);
    const before = await heartbeat(s.id);
    await recordGql(gqlCtx(member.id), s.id, kind);
    expect(await heartbeat(s.id)).toBeGreaterThan(before + HOUR); // moved to now, not a rounding bump
  });

  it('the roster reads the worker live after a kind:issue record that would otherwise have lapsed', async () => {
    const s = await session(anne, member.id, 23.9); // 6 minutes from lapsing
    await recordGql(gqlCtx(member.id), s.id, 'issue');
    const later = new Date(Date.now() + 0.5 * HOUR); // 30 minutes on, it would have lapsed without the refresh
    const statuses = await loadWorkerCheckStatuses(db as never, { appId: app.id, teamChannelId: null, workerIds: [anne.id], now: later });
    expect(statuses.get(anne.id)!.status).not.toBe('NO_SESSION');
  });
});

describe('#3078 acceptance 2: no revival, never another worker\'s session', () => {
  it('a lapsed session is recorded against (late attribution) but not revived', async () => {
    const s = await session(anne, member.id, 30);
    const before = await heartbeat(s.id);
    await expect(recordGql(gqlCtx(member.id), s.id)).resolves.toMatchObject({ sessionId: s.id });
    expect(await heartbeat(s.id)).toBe(before);
    const statuses = await loadWorkerCheckStatuses(db as never, { appId: app.id, teamChannelId: null, workerIds: [anne.id], now: new Date() });
    expect(statuses.get(anne.id)!.status).toBe('NO_SESSION');
  });

  it('an ended session is recorded against but not touched', async () => {
    const s = await session(anne, member.id, 20, 19);
    const before = await heartbeat(s.id);
    await expect(recordGql(gqlCtx(member.id), s.id)).resolves.toMatchObject({ sessionId: s.id });
    expect(await heartbeat(s.id)).toBe(before);
  });

  it('a platform admin may record against another user\'s worker session, but does not drive it', async () => {
    const s = await session(liam, other.id, 20);
    const before = await heartbeat(s.id);
    // Control: the record itself is admitted (the session write gate's platform-admin branch).
    await expect(recordGql(gqlCtx(platformAdmin.id, { roles: ['ADMIN'] }), s.id)).resolves.toMatchObject({ sessionId: s.id, workerId: liam.id });
    expect(await heartbeat(s.id)).toBe(before);
  });

  it('a member naming another user\'s worker session is refused and touches nothing', async () => {
    const s = await session(liam, other.id, 20);
    const before = await heartbeat(s.id);
    await expect(recordGql(gqlCtx(member.id), s.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await heartbeat(s.id)).toBe(before);
  });
});

describe('#3078 acceptance 3: impersonation and a removed caller cause no heartbeat', () => {
  it('impersonation: the record is refused and the session is untouched', async () => {
    const s = await session(anne, member.id, 20);
    const before = await heartbeat(s.id);
    await expect(recordGql(gqlCtx(member.id, { impersonation: impersonating() }), s.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await heartbeat(s.id)).toBe(before);
  });

  it('a caller removed from the App: the record is refused and the session is untouched', async () => {
    const s = await session(rex, removed.id, 20);
    const before = await heartbeat(s.id);
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: removed.id } } });
    await expect(recordGql(gqlCtx(removed.id), s.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await heartbeat(s.id)).toBe(before);
  });
});

describe('#3078 acceptance 5: kind:pr behaves as before', () => {
  it('live: prNumber is denormalized and the session is driven', async () => {
    const s = await session(anne, member.id, 20);
    const before = await heartbeat(s.id);
    await recordGql(gqlCtx(member.id), s.id, 'pr');
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.prNumber).toBe(371);
    expect(row.updatedAt!.getTime()).toBeGreaterThan(before + HOUR);
  });

  it('lapsed: prNumber is denormalized and the heartbeat stays pinned', async () => {
    const s = await session(anne, member.id, 30);
    const before = await heartbeat(s.id);
    await recordGql(gqlCtx(member.id), s.id, 'pr');
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.prNumber).toBe(371);
    expect(row.updatedAt!.getTime()).toBe(before);
  });
});

/**
 * Acceptance 4. Each fixture is built twice — once per surface, on its own session — and both surfaces must leave the
 * session in the same liveness state. `drives` is the expected answer; it is asserted on both, so a surface that
 * drifts in either direction fails here even if the other drifts with it.
 */
type Fixture = { sessionId: string; userId: string; extra: { gql: Partial<Context>; mcp: Partial<AuthContext> } };
const FIXTURES: [string, () => Promise<Fixture>, boolean][] = [
  ['live own session', async () => ({ sessionId: (await session(anne, member.id, 20)).id, userId: member.id, extra: { gql: {}, mcp: {} } }), true],
  ['lapsed own session', async () => ({ sessionId: (await session(anne, member.id, 30)).id, userId: member.id, extra: { gql: {}, mcp: {} } }), false],
  ['ended own session', async () => ({ sessionId: (await session(anne, member.id, 20, 19)).id, userId: member.id, extra: { gql: {}, mcp: {} } }), false],
  ['another worker\'s session (platform admin)', async () => ({ sessionId: (await session(liam, other.id, 20)).id, userId: platformAdmin.id, extra: { gql: { roles: ['ADMIN'] }, mcp: { roles: ['ADMIN'] } } }), false],
  ['another worker\'s session (member)', async () => ({ sessionId: (await session(liam, other.id, 20)).id, userId: member.id, extra: { gql: {}, mcp: {} } }), false],
  ['impersonation', async () => {
    const imp = impersonating();
    return { sessionId: (await session(anne, member.id, 20)).id, userId: member.id, extra: { gql: { impersonation: imp }, mcp: { impersonation: imp } } };
  }, false],
  ['removed caller', async () => {
    const id = (await session(rex, removed.id, 20)).id;
    await db.appMember.deleteMany({ where: { appId: app.id, userId: removed.id } });
    return { sessionId: id, userId: removed.id, extra: { gql: {}, mcp: {} } };
  }, false],
];

describe('#3078 acceptance 4: GraphQL recordTeamWork and MCP hadron_record_work agree on every fixture', () => {
  it.each(FIXTURES)('%s', async (_name, build, drives) => {
    const g = await build();
    const gBefore = await heartbeat(g.sessionId);
    await recordGql(gqlCtx(g.userId, g.extra.gql), g.sessionId).catch(() => undefined);
    const gqlDrove = (await heartbeat(g.sessionId)) > gBefore + HOUR;

    if (_name === 'removed caller') await db.appMember.create({ data: { appId: app.id, userId: removed.id, role: 'member' } });
    const m = await build();
    const mBefore = await heartbeat(m.sessionId);
    await recordMcp(mcpAuth(m.userId, m.extra.mcp), m.sessionId);
    const mcpDrove = (await heartbeat(m.sessionId)) > mBefore + HOUR;

    expect({ gql: gqlDrove, mcp: mcpDrove }).toEqual({ gql: drives, mcp: drives });
  });
});
