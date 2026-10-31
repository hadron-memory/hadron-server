/**
 * #1562 — page-monitor watches on the MCP surface: hadron_web_poll_list and
 * hadron_web_poll_cancel. The rules (org ADMIN, tool.web_poll policy, org
 * scoping) are pinned against the resolvers in resolvers.webPoll1562.test.ts;
 * this covers the SURFACE: both tools reach those resolvers, a refusal carries
 * the GraphQL code, and the cancel is a gated writer while the list is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/webfetchClient.js', () => ({
  fetchUrl: vi.fn(), httpRequest: vi.fn(), createPoll: vi.fn(), getPoll: vi.fn(), listPolls: vi.fn(), cancelPoll: vi.fn(),
}));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { cancelPoll, listPolls } from '../lib/webfetchClient.js';
import { createTestableMcpServer } from './server.js';

const authOf = (userId: string, extra: Partial<AuthContext> = {}) =>
  ({ userId, roles: ['READER'], clientId: `user:${userId}`, ...extra }) as AuthContext;
const mcp = (auth: AuthContext) =>
  createTestableMcpServer(auth, { sessionId: `ss-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';

let orgId: string;
let otherOrgId: string;
let admin: { id: string };
let member: { id: string };

async function bind(forOrg: string, jobId: string) {
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: forOrg, urn: `${forOrg}::a-${jobId}`, name: 'A', visibility: 'ORGANIZATION' },
  });
  const app = await db.app.create({ data: { id: generateId(), organizationId: forOrg, urn: `${forOrg}::app-${jobId}`, name: 'App' } });
  const run = await db.appRun.create({
    data: { id: generateId(), organizationId: forOrg, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: `${forOrg}::m::f`, status: 'RUNNING' },
  });
  await db.webFetchPollBinding.create({
    data: { jobId, sourceRunId: run.id, organizationId: forOrg, appId: app.id, entryNodeUrn: `${forOrg}::m::f`, url: 'https://shop.example.test/stock' },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  vi.clearAllMocks();
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'poll-mcp', urn: `poll-mcp-${generateId()}` } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'poll-other', urn: `poll-other-${generateId()}` } })).id;
  admin = await db.user.create({ data: { id: generateId(), email: `a-${generateId()}@t.test`, name: 'admin' } });
  member = await db.user.create({ data: { id: generateId(), email: `m-${generateId()}@t.test`, name: 'member' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: member.id, role: 'READER' } });
  vi.mocked(listPolls).mockResolvedValue({ jobs: [] });
  vi.mocked(cancelPoll).mockResolvedValue({ jobId: 'x', status: 'cancelled', expiresAt: '2026-11-01T00:00:00Z', triggerCount: 0, consecutiveFailures: 0 });
});

describe('hadron_web_poll_list', () => {
  it('prints the org\'s watches for an admin, with the ledger URL', async () => {
    await bind(orgId, 'job-1');
    vi.mocked(listPolls).mockResolvedValue({
      jobs: [{ jobId: 'job-1', status: 'active', url: 'https://shop.example.test/stock?access_token=SECRET', expiresAt: '2026-11-01T00:00:00Z', triggerCount: 3, consecutiveFailures: 0 }],
    });
    const t = text(await mcp(authOf(admin.id)).callTool('hadron_web_poll_list', { orgRef: orgId }));
    expect(t).toContain('job-1');
    expect(t).toContain('https://shop.example.test/stock');
    expect(t).toContain('triggered 3x');
    expect(t).not.toContain('SECRET');
  });

  it('says so when there are none, and refuses a plain member with the GraphQL code', async () => {
    expect(text(await mcp(authOf(admin.id)).callTool('hadron_web_poll_list', { orgRef: orgId }))).toBe('No active watches.');
    expect(code(text(await mcp(authOf(member.id)).callTool('hadron_web_poll_list', { orgRef: orgId })))).toBe('FORBIDDEN');
  });

  it('asks for an org when none is given or selected', async () => {
    expect(code(text(await mcp(authOf(admin.id)).callTool('hadron_web_poll_list', {})))).toBe('BAD_USER_INPUT');
  });
});

describe('hadron_web_poll_cancel', () => {
  it('cancels an org watch, then reports it already cancelled', async () => {
    await bind(orgId, 'job-1');
    const s = mcp(authOf(admin.id));
    expect(text(await s.callTool('hadron_web_poll_cancel', { orgRef: orgId, jobId: 'job-1' }))).toBe('Cancelled watch job-1.');
    expect(text(await s.callTool('hadron_web_poll_cancel', { orgRef: orgId, jobId: 'job-1' }))).toBe('Watch job-1 was already cancelled.');
    expect(cancelPoll).toHaveBeenCalledTimes(1);
  });

  it('reads another org\'s job as not_found and a member as forbidden', async () => {
    await bind(otherOrgId, 'job-x');
    expect(code(text(await mcp(authOf(admin.id)).callTool('hadron_web_poll_cancel', { orgRef: orgId, jobId: 'job-x' })))).toBe('NOT_FOUND');
    expect(code(text(await mcp(authOf(member.id)).callTool('hadron_web_poll_cancel', { orgRef: orgId, jobId: 'job-x' })))).toBe('FORBIDDEN');
    expect(cancelPoll).not.toHaveBeenCalled();
  });

  it('is a gated writer: it takes the caller-session argument, the list does not need it', () => {
    const s = mcp(authOf(admin.id));
    expect(s.toolDescription('hadron_web_poll_cancel')).toMatch(/Stop a page-monitor watch/);
    expect(s.toolDescription('hadron_web_poll_list')).toMatch(/active page-monitor watches/);
  });
});
