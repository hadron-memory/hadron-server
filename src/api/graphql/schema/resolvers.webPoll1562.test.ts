/**
 * #1562 — page-monitor watches (`web_poll_*`) listed and cancelled OUTSIDE a
 * run: org ADMIN gated, org-scoped through the core routing binding, and
 * subject to the same `tool.web_poll` policy action the run tools walk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/webfetchClient.js', () => ({
  fetchUrl: vi.fn(),
  httpRequest: vi.fn(),
  createPoll: vi.fn(),
  getPoll: vi.fn(),
  listPolls: vi.fn(),
  cancelPoll: vi.fn(),
}));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { cancelPoll, listPolls, type WebPollStatus } from '../../../lib/webfetchClient.js';
import { resolvers, type Context } from './resolvers.js';

type Fixture = { org: { id: string }; admin: { id: string }; member: { id: string } };

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

async function seedOrg(name: string, orgPolicy?: unknown): Promise<Fixture & { appId: string; runId: string }> {
  const org = await db.organization.create({
    data: { id: generateId(), name, urn: `${name}-${generateId()}`, ...(orgPolicy ? { policy: orgPolicy as never } : {}) },
  });
  const mk = async (label: string, role: 'ADMIN' | 'READER') => {
    const user = await db.user.create({ data: { id: generateId(), email: `${label}-${generateId()}@poll.test`, name: label } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role } });
    return user;
  };
  const admin = await mk('admin', 'ADMIN');
  const member = await mk('member', 'READER');
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.id}::a`, name: 'A', visibility: 'ORGANIZATION' },
  });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.id}::app`, name: 'App' } });
  const run = await db.appRun.create({
    data: {
      id: generateId(), organizationId: org.id, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL',
      entryNodeUrn: `${org.id}::m::flow:start`, status: 'RUNNING',
    },
  });
  return { org, admin, member, appId: app.id, runId: run.id };
}

async function bind(f: { org: { id: string }; appId: string; runId: string }, jobId: string, extra: Record<string, unknown> = {}) {
  return db.webFetchPollBinding.create({
    data: {
      jobId, sourceRunId: f.runId, organizationId: f.org.id, appId: f.appId,
      entryNodeUrn: `${f.org.id}::m::flow:start`, url: 'https://shop.example.test/stock', ...extra,
    },
  });
}

const status = (jobId: string, extra: Partial<WebPollStatus> = {}): WebPollStatus => ({
  jobId, status: 'active', expiresAt: '2026-11-01T00:00:00Z', triggerCount: 0, consecutiveFailures: 0, ...extra,
});

const Q = resolvers.Query as unknown as {
  webPolls: (p: unknown, a: { orgRef: string }, c: Context) => Promise<Array<Record<string, unknown>>>;
};
const M = resolvers.Mutation as unknown as {
  cancelWebPoll: (p: unknown, a: { orgRef: string; jobId: string }, c: Context) => Promise<Record<string, unknown>>;
};

beforeEach(async () => {
  await cleanDb(db);
  vi.clearAllMocks();
  vi.mocked(listPolls).mockResolvedValue({ jobs: [] });
  vi.mocked(cancelPoll).mockResolvedValue(status('x', { status: 'cancelled' }));
});

describe('webPolls (#1562)', () => {
  it('lists an active watch for an org admin, with the redacted ledger URL, never the sidecar URL', async () => {
    const a = await seedOrg('org-a');
    await bind(a, 'job-1', { url: 'https://shop.example.test/stock' });
    vi.mocked(listPolls).mockResolvedValue({
      jobs: [status('job-1', { url: 'https://shop.example.test/stock?access_token=SECRET', triggerCount: 2, orgId: a.org.id })],
    });
    const out = await Q.webPolls({}, { orgRef: a.org.id }, ctxFor(a.admin.id));
    expect(listPolls).toHaveBeenCalledWith(a.org.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      jobId: 'job-1', status: 'active', url: 'https://shop.example.test/stock',
      appId: a.appId, triggerCount: 2, consecutiveFailures: 0,
    });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('drops sidecar jobs that have no binding in this org', async () => {
    const a = await seedOrg('org-a');
    const b = await seedOrg('org-b');
    await bind(a, 'job-a');
    await bind(b, 'job-b');
    vi.mocked(listPolls).mockResolvedValue({ jobs: [status('job-a'), status('job-b'), status('job-unbound')] });
    const out = await Q.webPolls({}, { orgRef: a.org.id }, ctxFor(a.admin.id));
    expect(out.map((r) => r.jobId)).toEqual(['job-a']);
  });

  it('refuses a plain member and an admin of another org', async () => {
    const a = await seedOrg('org-a');
    const b = await seedOrg('org-b');
    await expect(Q.webPolls({}, { orgRef: a.org.id }, ctxFor(a.member.id))).rejects.toThrow('Forbidden');
    await expect(Q.webPolls({}, { orgRef: a.org.id }, ctxFor(b.admin.id))).rejects.toThrow('Forbidden');
    expect(listPolls).not.toHaveBeenCalled();
  });

  it('is denied when the org policy does not allow tool.web_poll', async () => {
    const a = await seedOrg('org-a', { allow: ['run.execute'] });
    await expect(Q.webPolls({}, { orgRef: a.org.id }, ctxFor(a.admin.id))).rejects.toMatchObject({
      extensions: { code: 'POLICY_DENIED' },
    });
    expect(listPolls).not.toHaveBeenCalled();
  });

  it('is denied when the caller\'s own user policy does not allow tool.web_poll', async () => {
    const a = await seedOrg('org-a');
    await db.user.update({ where: { id: a.admin.id }, data: { policy: { allow: ['tool.mcp.*'] } as never } });
    await expect(Q.webPolls({}, { orgRef: a.org.id }, ctxFor(a.admin.id))).rejects.toMatchObject({
      extensions: { code: 'POLICY_DENIED' },
    });
  });
});

describe('cancelWebPoll (#1562)', () => {
  it('cancels an active watch at the sidecar and records it on the binding', async () => {
    const a = await seedOrg('org-a');
    await bind(a, 'job-1');
    const out = await M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-1' }, ctxFor(a.admin.id));
    expect(out).toMatchObject({ jobId: 'job-1', cancelled: true, alreadyCancelled: false });
    expect(cancelPoll).toHaveBeenCalledWith('job-1');
    const row = await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: 'job-1' } });
    expect(row.cancelledAt).not.toBeNull();
  });

  it('is idempotent: a second cancel reports alreadyCancelled without calling the sidecar again', async () => {
    const a = await seedOrg('org-a');
    await bind(a, 'job-1', { cancelledAt: new Date() });
    const out = await M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-1' }, ctxFor(a.admin.id));
    expect(out).toMatchObject({ jobId: 'job-1', cancelled: true, alreadyCancelled: true });
    expect(cancelPoll).not.toHaveBeenCalled();
  });

  it('reads another org\'s job as nonexistent, and touches nothing', async () => {
    const a = await seedOrg('org-a');
    const b = await seedOrg('org-b');
    await bind(b, 'job-b');
    await expect(M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-b' }, ctxFor(a.admin.id))).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    await expect(M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-nope' }, ctxFor(a.admin.id))).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(cancelPoll).not.toHaveBeenCalled();
    const row = await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: 'job-b' } });
    expect(row.cancelledAt).toBeNull();
  });

  it('refuses a plain member and a policy that omits tool.web_poll before touching the sidecar', async () => {
    const a = await seedOrg('org-a');
    const p = await seedOrg('org-p', { allow: ['llm.invoke'] });
    await bind(a, 'job-1');
    await bind(p, 'job-p');
    await expect(M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-1' }, ctxFor(a.member.id))).rejects.toThrow('Forbidden');
    await expect(M.cancelWebPoll({}, { orgRef: p.org.id, jobId: 'job-p' }, ctxFor(p.admin.id))).rejects.toMatchObject({
      extensions: { code: 'POLICY_DENIED' },
    });
    expect(cancelPoll).not.toHaveBeenCalled();
  });

  it('leaves the binding uncancelled when the sidecar cancel fails', async () => {
    const a = await seedOrg('org-a');
    await bind(a, 'job-1');
    vi.mocked(cancelPoll).mockRejectedValue(new Error('sidecar down'));
    await expect(M.cancelWebPoll({}, { orgRef: a.org.id, jobId: 'job-1' }, ctxFor(a.admin.id))).rejects.toThrow('sidecar down');
    const row = await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: 'job-1' } });
    expect(row.cancelledAt).toBeNull();
  });
});
