/**
 * h-search (global cross-entity search) MCP tool coverage. Drives the real
 * production tool closure via createTestableMcpServer (which bypasses zod, so
 * this also exercises the handler's defensive arg normalization).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };

function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'hs-org', urn: 'hs-org' } });
  admin = await db.user.create({ data: { githubId: 8801, githubUsername: 'hs-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'hs-org:alpha', name: 'Alpha Memory', class: 'knowledge' },
  });
  await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: 'hs-org:juno', name: 'Juno Agent', visibility: 'ORGANIZATION' },
  });
});

describe('h-search', () => {
  it('returns a ranked cross-entity list', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-search', { query: 'Alpha' });
    expect(text).toContain('[memory]');
    expect(text).toContain('Alpha Memory');
  });

  it('rejects unauthenticated callers', async () => {
    const srv = createTestableMcpServer({} as AuthContext);
    const text = await srv.callToolText('h-search', { query: 'Alpha' });
    expect(text).toBe('Not authenticated.');
  });

  it('normalizes junk entityTypes defensively (zod is bypassed in tests)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-search', {
      query: 'Juno',
      entityTypes: ['agent', 'bogus', 123],
    });
    expect(text).toContain('Juno Agent');
  });

  it('honors a valid entityTypes filter', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('h-search', { query: 'Juno', entityTypes: ['memory'] });
    expect(text).toContain('No results');
  });
});
