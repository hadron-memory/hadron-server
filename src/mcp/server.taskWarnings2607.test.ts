import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #2607 — hadron_task_cancel and hadron_alarm_ack render their warnings in the same place as the other task tools:
 * lines after the result text. A refusal stays a refusal, with no warning lines.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let app: { id: string };
let admin: { id: string };
let member: { id: string };
let ada: { id: string };

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) => createTestableMcpServer(auth, { sessionId: `tw7-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const plainSession = (userId: string) => db.session.create({ data: { id: generateId(), userId }, select: { id: true } });
const task = (data: Record<string, unknown>) =>
  db.agentTask.create({ data: { id: generateId(), appId: app.id, title: 'T', ...data } as any, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'TW7 MCP', urn: `tw7mcp-${generateId().toLowerCase()}.example` } });
  admin = await db.user.create({ data: { githubId: 260711, githubUsername: 'tw7m-admin', handle: 'tw7m-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 260712, githubUsername: 'tw7m-member', handle: 'tw7m-member', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id.toLowerCase()}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Ada', slug: 'ada' }, select: { id: true } });
});

describe('hadron_task_cancel', () => {
  it('a cancel with an open child warns and still cancels; a childless one does not', async () => {
    const s = mcp(authOf(member.id));
    const plain = await plainSession(member.id);
    const parent = await task({ ownerUserId: member.id });
    await task({ parentTaskId: parent.id, ownerUserId: member.id, status: 'pending' });
    const out = text(await s.callTool('hadron_task_cancel', { taskId: parent.id, session: plain.id }));
    expect(out).toMatch(/Cancelled\./);
    expect(out).toContain('\nWarning [task.cancel.open-children]: This task still has open child tasks; cancelling it does not end them.');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('cancelled');
    const solo = await task({ ownerUserId: member.id });
    expect(text(await s.callTool('hadron_task_cancel', { taskId: solo.id, session: plain.id }))).not.toMatch(/Warning \[/);
  });
});

describe('hadron_alarm_ack', () => {
  const alarm = async () => {
    const t = await task({ ownerWorkerId: ada.id });
    return db.agentTeamEvent.create({
      data: { appId: app.id, taskId: t.id, type: 'stall.not-started', severity: 'alarm', episodeStart: new Date(), chain: [{ workerId: ada.id }, { userId: admin.id, via: 'manager' }] },
    });
  };

  it('a manager outside the chain gets the warning line after the event; the ack stands', async () => {
    const a = await alarm();
    const s = mcp(authOf(admin.id));
    const plain = await plainSession(admin.id);
    const out = text(await s.callTool('hadron_alarm_ack', { eventId: a.id, session: plain.id }));
    expect(out).toMatch(/^Acknowledged\./);
    expect(out).toMatch(/\n\nWarning \[alarm\.ack\.outside-chain\]: You acknowledged an alarm outside its chain, as a manager of the App\.$/);
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: a.id } })).acknowledgedAt).not.toBeNull();
  });

  it('a refused ack carries no warning lines', async () => {
    const a = await alarm();
    const s = mcp(authOf(member.id));
    const plain = await plainSession(member.id);
    const out = text(await s.callTool('hadron_alarm_ack', { eventId: a.id, session: plain.id }));
    expect(out).toMatch(/ALARM_NOT_IN_CHAIN|alarm_not_in_chain/i);
    expect(out).not.toMatch(/Warning \[/);
  });
});
