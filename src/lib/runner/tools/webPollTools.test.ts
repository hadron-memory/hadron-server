import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../webfetchClient.js', () => ({
  fetchUrl: vi.fn(),
  httpRequest: vi.fn(),
  createPoll: vi.fn(),
  getPoll: vi.fn(),
  listPolls: vi.fn(),
  cancelPoll: vi.fn(),
}));

import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../id.js';
import { encryptToken } from '../../tokenCrypto.js';
import { cleanDb } from '../../../test/helpers.js';
import { cancelPoll, createPoll, listPolls } from '../../webfetchClient.js';
import { resolveRunTools, webPollCancel, webPollList, webPollStart } from './index.js';
import type { RunToolContext } from './types.js';

async function seedContext(): Promise<{ ctx: RunToolContext; credentialName: string; secretId: string }> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Poll Org', urn: `poll-${generateId()}` },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::credentials`,
      name: 'credentials',
      class: 'knowledge',
    },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::poll-agent`,
      name: 'Poll agent',
      visibility: 'ORGANIZATION',
    },
  });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}::poll-app`, name: 'Poll App' },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read' } });
  const entryNodeUrn = `${memory.urn}::flow:start`;
  const run = await db.appRun.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      appId: app.id,
      agentId: agent.id,
      triggerKind: 'MANUAL',
      entryNodeUrn,
      policy: { chain: [{ allow: ['run.execute', 'llm.invoke', 'tool.web_poll'] }] },
      status: 'RUNNING',
    },
  });
  // Org-scoped webfetch-auth secret (#677; secrets are org/user-only, #696) —
  // the cascade resolves it for any run under this org.
  const secret = await db.secret.create({
    data: {
      ownerType: 'org',
      ownerId: org.id,
      name: 'api-cred',
      kind: 'webfetch-auth',
      metadata: { type: 'bearer', urlPrefix: 'https://api.example.test/v1/' },
      valueEncrypted: encryptToken(JSON.stringify({ type: 'bearer', token: 'poll-secret' })),
    },
  });
  return {
    credentialName: 'api-cred',
    secretId: secret.id,
    ctx: {
      db,
      run,
      log: vi.fn(),
      principal: {
        db,
        appId: app.id,
        organizationId: org.id,
        clientId: `run:${run.id}`,
      },
    },
  };
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);
  vi.clearAllMocks();
  vi.mocked(createPoll).mockResolvedValue({
    jobId: 'poll-job-1',
    nextRunAt: '2026-07-14T20:01:00Z',
    expiresAt: '2026-07-15T20:00:00Z',
  });
  vi.mocked(cancelPoll).mockResolvedValue({
    jobId: 'poll-job-1',
    status: 'cancelled',
    expiresAt: '2026-07-15T20:00:00Z',
    triggerCount: 0,
    consecutiveFailures: 0,
  });
  vi.mocked(listPolls).mockResolvedValue({ jobs: [] });
});

describe('web poll run tools', () => {
  it('shares tool.web_poll while retaining correct action-budget costs and registry names', () => {
    expect(webPollStart.policyAction).toBe('tool.web_poll');
    expect(webPollCancel.policyAction).toBe('tool.web_poll');
    expect(webPollList.policyAction).toBe('tool.web_poll');
    expect([webPollStart.cost, webPollCancel.cost, webPollList.cost]).toEqual([1, 1, 0]);
    const { tools, unknown } = resolveRunTools(['web_poll_start', 'web_poll_cancel', 'web_poll_list']);
    expect(unknown).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['web_poll_start', 'web_poll_cancel', 'web_poll_list']),
    );
  });

  it('resolves and injects a named secret server-side, then persists the origin-run binding and redacted ledger', async () => {
    const { ctx, credentialName, secretId } = await seedContext();
    const out = await webPollStart.execute(ctx, {
      url: 'https://api.example.test/v1/orders?access_token=do-not-log',
      contentKind: 'json',
      conditions: [{ id: 'ready', type: 'json_path', path: 'state', op: 'eq', value: 'ready' }],
      intervalSeconds: 60,
      ttlSeconds: 3600,
      credentialName,
    });

    expect(out).toEqual({ jobId: 'poll-job-1', expiresAt: '2026-07-15T20:00:00Z' });
    expect(createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ctx.run.organizationId,
        appId: ctx.run.appId,
        credentialsNodeUrn: `secret:${secretId}`,
        urlPrefix: 'https://api.example.test/v1/',
        auth: { type: 'bearer', token: 'poll-secret' },
      }),
    );
    const binding = await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: 'poll-job-1' } });
    expect(binding).toMatchObject({
      sourceRunId: ctx.run.id,
      organizationId: ctx.run.organizationId,
      appId: ctx.run.appId,
      credentialSecretId: secretId,
      url: 'https://api.example.test/v1/orders',
    });
    const log = vi.mocked(ctx.log).mock.calls[0]![0];
    expect(log).toContain('poll-job-1');
    expect(log).not.toContain('poll-secret');
    expect(log).not.toContain('do-not-log');
  });

  it('rejects an origin/path near miss before decrypting or creating a job', async () => {
    const { ctx, credentialName } = await seedContext();
    await expect(
      webPollStart.execute(ctx, {
        url: 'https://api.example.test/v10/orders',
        conditions: [{ id: 'x', type: 'content_changed' }],
        intervalSeconds: 60,
        ttlSeconds: 3600,
        credentialName,
      }),
    ).rejects.toThrow(/outside the secret urlPrefix/);
    expect(createPoll).not.toHaveBeenCalled();
  });

  it('fails loud when the name does not resolve or a nearer scope shadows it with the wrong kind', async () => {
    const { ctx } = await seedContext();
    await expect(
      webPollStart.execute(ctx, {
        url: 'https://api.example.test/v1/orders',
        conditions: [{ id: 'x', type: 'content_changed' }],
        intervalSeconds: 60,
        ttlSeconds: 3600,
        credentialName: 'missing-cred',
      }),
    ).rejects.toThrow(/no secret named "missing-cred"/i);

    // A generic secret of the same name at the SAME winning scope must not
    // silently satisfy the webfetch-auth path.
    await db.secret.updateMany({
      where: { name: 'api-cred' },
      data: { kind: 'generic', metadata: {} },
    });
    await expect(
      webPollStart.execute(ctx, {
        url: 'https://api.example.test/v1/orders',
        conditions: [{ id: 'x', type: 'content_changed' }],
        intervalSeconds: 60,
        ttlSeconds: 3600,
        credentialName: 'api-cred',
      }),
    ).rejects.toThrow(/kind "generic", not "webfetch-auth"/);
    expect(createPoll).not.toHaveBeenCalled();
  });

  it('treats explicit null optional arguments as omitted', async () => {
    const { ctx } = await seedContext();

    await webPollStart.execute(ctx, {
      url: 'https://api.example.test/v1/orders',
      contentKind: null,
      mode: null,
      firePolicy: null,
      cooldownSeconds: null,
      conditions: [{ id: 'x', type: 'content_changed' }],
      intervalSeconds: 60,
      ttlSeconds: 3600,
    });

    expect(createPoll).toHaveBeenCalledWith(
      expect.not.objectContaining({
        contentKind: expect.anything(),
        mode: expect.anything(),
        firePolicy: expect.anything(),
        cooldownSeconds: expect.anything(),
      }),
    );
  });

  it('cancels only a job bound to the run organization and lists by that immutable org id', async () => {
    const { ctx } = await seedContext();
    await db.webFetchPollBinding.create({
      data: {
        jobId: 'poll-job-1',
        sourceRunId: ctx.run.id,
        organizationId: ctx.run.organizationId,
        appId: ctx.run.appId,
        agentId: ctx.run.agentId,
        entryNodeUrn: ctx.run.entryNodeUrn,
        url: 'https://api.example.test/v1/orders',
      },
    });
    await expect(webPollCancel.execute(ctx, { jobId: 'foreign-job' })).rejects.toThrow(/not found/);
    await expect(webPollCancel.execute(ctx, { jobId: 'poll-job-1' })).resolves.toEqual({
      jobId: 'poll-job-1',
      cancelled: true,
    });
    expect(cancelPoll).toHaveBeenCalledWith('poll-job-1');
    expect((await db.webFetchPollBinding.findUniqueOrThrow({ where: { jobId: 'poll-job-1' } })).cancelledAt).not.toBeNull();

    await webPollList.execute(ctx, {});
    expect(listPolls).toHaveBeenCalledWith(ctx.run.organizationId);
  });
});
