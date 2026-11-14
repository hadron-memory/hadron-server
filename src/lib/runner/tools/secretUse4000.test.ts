/** S5 red preparation (#4000): public run-tool boundary, before S3 merges.
 * No client-table/helper assumptions: real isolated run, synthetic missing id,
 * mocked outbound capability only. Grant/reach/ticket fixtures follow S3.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import type { RunToolContext } from './types.js';
vi.mock('../../webfetchClient.js', () => ({ httpRequest: vi.fn(), fetchUrl: vi.fn() }));
import { httpRequest } from '../../webfetchClient.js';
import { webRequest } from './webTools.js';

let ctx: RunToolContext;
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const user = await db.user.create({ data: { email: `${generateId()}@s5.test` } });
  const org = await db.organization.create({ data: {
    name: 'S5 synthetic', urn: `s5-${generateId().toLowerCase()}`,
  } });
  const app = await db.app.create({ data: {
    name: 'S5 synthetic', organizationId: org.id,
    urn: `hrn:app:example.test:s5-${generateId().toLowerCase()}`,
  } });
  const agent = await db.agent.create({ data: {
    name: 'S5 synthetic', organizationId: org.id,
    urn: `hrn:agent:example.test:s5-${generateId().toLowerCase()}`,
  } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const run = await db.appRun.create({ data: {
    organizationId: org.id, appId: app.id, agentId: agent.id,
    userId: user.id, triggerKind: 'MANUAL', status: 'RUNNING',
    entryNodeUrn: 'hrn:node:example.test:flows:start',
  } });
  ctx = { db, run, log: vi.fn(), principal: {
    db, appId: app.id, organizationId: org.id, clientId: `run:${run.id}`,
  } };
  vi.mocked(httpRequest).mockResolvedValue({
    method: 'GET', finalUrl: 'https://api.example.test/v1/orders',
    status: 200, headers: {}, body: 'synthetic',
  } as never);
});

describe('S5 secret.use public run-tool boundary', () => {
  it('advertises an optional client reference, never a plaintext auth parameter', () => {
    const schema = webRequest.inputSchema as {
      properties: Record<string, unknown>; required: string[];
    };
    expect(schema.properties.secretClientId).toMatchObject({ type: 'string' });
    expect(schema.required).not.toContain('secretClientId');
    expect(schema.properties).not.toHaveProperty('auth');
  });

  it('does not silently downgrade a missing secret client to an anonymous outbound request', async () => {
    await expect(webRequest.execute(ctx, {
      method: 'GET', url: 'https://api.example.test/v1/orders',
      secretClientId: generateId(),
    })).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(httpRequest).not.toHaveBeenCalled();
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it('keeps ordinary requests without a client on the existing anonymous path', async () => {
    await expect(webRequest.execute(ctx, {
      method: 'GET', url: 'https://api.example.test/v1/orders',
    })).resolves.toMatchObject({ status: 200, body: 'synthetic' });
    expect(httpRequest).toHaveBeenCalledExactlyOnceWith({
      method: 'GET', url: 'https://api.example.test/v1/orders',
    });
  });
});
