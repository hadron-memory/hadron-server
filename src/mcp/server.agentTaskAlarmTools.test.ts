import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1706 — alarms and availability on the MCP surface: hadron_alarm_ack,
 * hadron_worker_availability_set, hadron_model_family_availability_set and
 * hadron_team_availability. The rules are pinned in
 * src/lib/agentTasks/stall.test.ts and resolvers.agentTaskAlarms.test.ts; this
 * covers the SURFACE: writes require `session`, a worker session acts as the
 * worker, refusals arrive as `[code] message`, and alarms render with their
 * chain and acknowledgement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { taskStallTick } from '../jobs/taskStallEvaluator.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let admin: { id: string };
let member: { id: string };
let app: { id: string };
let agentId: string;
let anne: { id: string };
let rook: { id: string };

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) =>
  createTestableMcpServer(auth, { sessionId: `aa-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';

async function session(data: { userId?: string; appId?: string; workerId?: string }) {
  return db.session.create({
    data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Alarm MCP', urn: `alarmmcp-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 700_000 + n, githubUsername: `aa-admin-${n}`, roles: [] } });
  member = await db.user.create({ data: { githubId: 800_000 + n, githubUsername: `aa-member-${n}`, roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `alarmmcp-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Anne', slug: 'anne', heldByUserId: member.id }, select: { id: true } });
  rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Rook', slug: 'rook', heldByUserId: member.id }, select: { id: true } });
});

/** Anne owns a review assigned to Rook, assigned 20 minutes ago and never started: one not-started alarm. */
async function alarmOnAnnesReview(): Promise<string> {
  const t0 = new Date(Date.now() - 20 * 60_000);
  await db.agentTask.create({
    data: { appId: app.id, title: 'Review', ownerWorkerId: anne.id, assigneeWorkerId: rook.id, assignedAt: t0, createdAt: t0 },
  });
  expect((await taskStallTick(db)).raised).toBe(1);
  const a = await db.agentTeamEvent.findFirstOrThrow({ where: { severity: 'alarm' } });
  return a.id;
}

describe('hadron_alarm_ack', () => {
  it('refuses without a session, and acknowledges as the worker in the chain', async () => {
    const id = await alarmOnAnnesReview();
    const s = mcp(authOf(member.id));
    expect(code(text(await s.callTool('hadron_alarm_ack', { eventId: id })))).toBe('SESSION_REQUIRED');
    const asRook = await session({ userId: member.id, appId: app.id, workerId: rook.id });
    expect(code(text(await s.callTool('hadron_alarm_ack', { eventId: id, session: asRook.id })))).toBe('ALARM_NOT_IN_CHAIN');
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const ok = text(await s.callTool('hadron_alarm_ack', { eventId: id, session: asAnne.id }));
    expect(ok).toMatch(/^Acknowledged\./);
    expect(ok).toMatch(/stall\.not-started \[ALARM\]/);
    expect(ok).toMatch(/acknowledged .* by worker Anne/);
    expect(ok).toMatch(/chain: worker Anne .*\(woken /);
    expect(code(text(await s.callTool('hadron_alarm_ack', { eventId: id, session: asAnne.id })))).toBe('ALARM_ALREADY_ACKNOWLEDGED');
  });

  it('hadron_team_events renders an alarm with its episode, chain and acknowledgement state', async () => {
    await alarmOnAnnesReview();
    const t = text(await mcp(authOf(member.id)).callTool('hadron_team_events', { appRef: app.id, alarmsOnly: true }));
    expect(t).toMatch(/stall\.not-started \[ALARM\]/);
    expect(t).toMatch(/episode since .* · not acknowledged/);
    expect(t).toMatch(/chain: worker Anne/);
  });
});

describe('availability tools', () => {
  it('a worker marks itself unavailable through its session, and may not mark itself available', async () => {
    const s = mcp(authOf(member.id));
    const asRook = await session({ userId: member.id, appId: app.id, workerId: rook.id });
    const set = text(await s.callTool('hadron_worker_availability_set', {
      worker: rook.id, state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS', session: asRook.id,
    }));
    expect(set).toMatch(/^Set\.\n\n- worker Rook .*: unavailable \(out-of-tokens\) · in effect · set .* by worker \(worker Rook/);
    expect(code(text(await s.callTool('hadron_worker_availability_set', {
      worker: rook.id, state: 'AVAILABLE', session: asRook.id,
    })))).toBe('AVAILABILITY_NOT_PERMITTED');
    expect(code(text(await s.callTool('hadron_worker_availability_set', {
      worker: 'Anne', appRef: app.id, state: 'UNAVAILABLE', reason: 'OTHER', session: asRook.id,
    })))).toBe('AVAILABILITY_NOT_PERMITTED');
  });

  it('the holder, as a person, sets either; the manager pauses a family; everyone in the App reads them', async () => {
    const plain = await session({ userId: member.id });
    const s = mcp(authOf(member.id));
    expect(text(await s.callTool('hadron_worker_availability_set', {
      worker: 'Anne', appRef: app.id, state: 'UNAVAILABLE', reason: 'HOST_DOWN', session: plain.id,
    }))).toMatch(/by holder \(user @/);
    expect(code(text(await s.callTool('hadron_model_family_availability_set', {
      appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER', session: plain.id,
    })))).toBe('AVAILABILITY_NOT_PERMITTED');
    const adminPlain = await session({ userId: admin.id });
    expect(text(await mcp(authOf(admin.id)).callTool('hadron_model_family_availability_set', {
      appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER', session: adminPlain.id,
    }))).toMatch(/family claude: unavailable \(other\) · in effect/);
    const read = text(await s.callTool('hadron_team_availability', { appRef: app.id }));
    expect(read).toMatch(/worker Anne .*: unavailable \(host-down\)/);
    expect(read).toMatch(/family claude: unavailable/);
  });
});

describe('#1960 hadron_alarm_ack discovery', () => {
  it('names both arms the resolver admits: an owner in the chain, or whoever manages the App', () => {
    const d = mcp(authOf('u-1960')).toolDescription('hadron_alarm_ack');
    expect(d).toContain("Any owner in the alarm's chain, or whoever manages the App (cor:agt:050:24), may acknowledge it");
    // The pre-#1960 text excluded managers outright.
    expect(d).not.toMatch(/chain may acknowledge it, and nobody else/);
  });
});
