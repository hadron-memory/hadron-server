/**
 * Unit tests for the public `Query.serverInfo` field — the GraphQL
 * counterpart to the hadron_server_info MCP tool. Reuses getDeploymentInfo(),
 * so it reports HADRON_SERVER_VERSION as `version` and the deployment's
 * canonical base URL. Public: needs no auth (empty context).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolvers } from './resolvers.js';
import { HADRON_SERVER_VERSION } from '../../../mcp/deploymentInfo.js';
import type { Context } from './resolvers.js';

const serverInfo = resolvers.Query.serverInfo as (
  p: unknown,
  a: unknown,
  c: Context,
) => Promise<{ version: string; baseUrl: string }>;

describe('Query.serverInfo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports the server-identity version (HADRON_SERVER_VERSION)', async () => {
    const info = await serverInfo({}, {}, {} as Context);
    expect(info.version).toBe(HADRON_SERVER_VERSION);
  });

  it('reports BASE_URL as the canonical baseUrl', async () => {
    vi.stubEnv('BASE_URL', 'https://api.example.com');
    const info = await serverInfo({}, {}, {} as Context);
    expect(info.baseUrl).toBe('https://api.example.com');
  });

  it('falls back to the local default when BASE_URL is unset/sentinel', async () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('PORT', '4000');
    const info = await serverInfo({}, {}, {} as Context);
    expect(info.baseUrl).toBe('http://localhost:4000');
  });

  it('requires no authentication (resolves with an empty context)', async () => {
    await expect(serverInfo({}, {}, {} as Context)).resolves.toBeDefined();
  });
});
