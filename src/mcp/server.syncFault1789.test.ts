/** #1789 (LOCAL P2-2): an unexpected sync exception's text is a fault, never a typed refusal on MCP. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/syncGraphFromGithub.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/github/syncGraphFromGithub.js')>()),
  syncGraphFromGithub: vi.fn(),
}));
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';
import { createTestableMcpServer } from './server.js';

const secret = '/srv/private/path.ts driver failure canary';
let userId: string;
beforeEach(async () => {
  await cleanDb(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const org = await db.organization.create({ data: { id: generateId(), urn: 'sync1789.example', name: 'Sync' } });
  const user = await db.user.create({ data: { githubId: 178902, githubUsername: 'sync1789', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  await db.memory.create({ data: { id: generateId(), urn: 'sync1789.example:mem', name: 'mem', class: 'knowledge', organizationId: org.id, source: 'https://github.com/example/repo' } });
});

const sync = async () => (await createTestableMcpServer({ userId, roles: ['READER'] })
  .callTool('hadron_sync_graph', { memoryUrn: 'hrn:mem:sync1789.example:mem' })) as { isError?: boolean; content: { text: string }[] };

describe('hadron_sync_graph failure classification (#1789)', () => {
  it('an unexpected exception is the generic envelope, not its text', async () => {
    vi.mocked(syncGraphFromGithub).mockResolvedValue({ error: secret, fault: true });
    const r = await sync();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain('private');
    expect(r.content[0].text).toMatch(/Request id/i);
  });

  it('a fault with an empty message is still a fault, never success', async () => {
    vi.mocked(syncGraphFromGithub).mockResolvedValue({ error: '', fault: true });
    const r = await sync();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Request id/i);
  });

  it('a typed sync refusal keeps its text', async () => {
    vi.mocked(syncGraphFromGithub).mockResolvedValue({ error: 'Invalid node name in repo', errorCode: 'BAD_USER_INPUT' });
    const r = await sync();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Invalid node name in repo');
  });
});
