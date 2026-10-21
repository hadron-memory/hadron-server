import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1707 — the team roster (plan design:agent-tasks §7.4), on GraphQL and MCP:
 * each derived state on its own, the order when several hold, the read
 * audience, and that a worker is rendered as a sanitized party.
 *
 * The roster reads the wall clock, so every timestamp here is relative to the
 * real now.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { registerHost } from '../../../lib/agentTasks/hosts.js';
import { rosterState } from '../../../lib/agentTasks/roster.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let appUrn: string;
let agentId: string;
let admin: { id: string };
let mia: { id: string };
let outsider: { id: string };
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Roster', urn: `roster-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 610_000 + n, githubUsername: `ro-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 620_000 + n, githubUsername: `ro-mia-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 630_000 + n, githubUsername: `ro-out-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  appUrn = `roster-${n}.example:team`;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: appUrn }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  for (const name of ['Anne', 'Rook', 'Kit']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  }
});

/** Bind a worker in a session of `family`, driven `minutesAgo` minutes ago. */
const bind = (name: string, family: string | null, minutesAgo = 0) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w[name].id, agentId, family, startedAt: ago(minutesAgo), updatedAt: ago(minutesAgo) },
  });

const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: mia.id, assignedAt: ago(5), ...(data.status === 'started' ? {startedAt: ago(1)} : {}), ...data }, select: { id: true } });

async function roster(userId = mia.id) {
  return Q.teamRoster({}, { appRef: app.id }, ctx(userId));
}
async function entry(name: string) {
  const r = await roster();
  return r.workers.find((e: { name: string }) => e.name === name);
}

describe('#2178 safe roster enrichment — red first', () => {
  it('returns explicit null for no task/own pause without inventing a status', async () => {
    const e = await entry('Kit');
    expect(e.currentTask).toBeNull();
    expect(e.pausedUntil).toBeNull();
    expect(e.state).toBe('NOT_LAUNCHABLE');
  });

  it('preserves an expired own pause timestamp separately from a team pause', async () => {
    const expired=ago(10);
    await db.workerWakeSettings.create({data:{workerId:w.Kit.id,pausedUntil:expired}});
    await db.app.update({where:{id:app.id},data:{teamPausedAt:new Date()}});
    expect((await entry('Kit')).pausedUntil).toEqual(expired);
  });

  it('selects STARTED ahead of PENDING, oldest assigned first, even without a session', async () => {
    await task({title:'pending older',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:ago(30)});
    const expected=await task({title:'started oldest',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(20)});
    await task({title:'started newer',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(5)});
    const e=await entry('Kit');
    expect(e.liveSession).toBe(false);
    expect(e.currentTask).toEqual({id:expected.id,title:'started oldest',status:'started'});
  });

  it('uses createdAt then id for equal assignment times', async () => {
    const time=ago(15);
    const a=await task({id:'a2178task000000000000000001',title:'first tie',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:time,createdAt:time});
    await task({id:'z2178task000000000000000001',title:'last tie',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:time,createdAt:time});
    expect((await entry('Kit')).currentTask).toEqual({id:a.id,title:'first tie',status:'pending'});
  });

  it('drops cancelled/reassigned tasks on the next read without matching side effects', async () => {
    const first=await task({title:'cancelled',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(30)});
    await db.agentTask.update({where:{id:first.id},data:{status:'cancelled',cancelledAt:new Date()}});
    const moved=await task({title:'elsewhere',status:'started',assigneeWorkerId:w.Rook.id,assignedAt:ago(20)});
    const expected=await task({title:'remaining pending',status:'pending',assigneeWorkerId:w.Kit.id,assignedAt:ago(10)});
    expect((await entry('Kit')).currentTask).toEqual({id:expected.id,title:'remaining pending',status:'pending'});
    expect((await entry('Rook')).currentTask.id).toBe(moved.id);
  });

  it('prints the same authorized selected title on the actual MCP roster tool', async () => {
    await task({title:'selected title 2178',status:'started',assigneeWorkerId:w.Kit.id,assignedAt:ago(1)});
    const srv=createTestableMcpServer({userId:mia.id,roles:['READER'],clientId:`user:${mia.id}`} as AuthContext);
    expect(await srv.callToolText('hadron_team_roster',{appRef:app.id})).toContain('selected title 2178');
  });
});
