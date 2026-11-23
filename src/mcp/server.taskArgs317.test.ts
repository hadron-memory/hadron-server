/**
 * #317 acceptance 6 — the required-argument refusal reaches MCP `hadron_run_task`
 * through its delegation to `Mutation.runTask` (no second implementation), and a
 * supplied argument still renders.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let auth: AuthContext;
let nodeUrn: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'mta-org', urn: 'mta-org' } });
  const admin = await db.user.create({ data: { githubId: 3173, githubUsername: 'mta-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'mta-tasks', urn: 'mta-org:mta-tasks', class: 'knowledge' },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      loc: 'tasks:needs-file',
      isLink: false,
      name: 'needs-file',
      nodeType: 'task',
      isRunnable: true,
      content: 'Process {{file_path}}',
      tags: [],
      data: { args: { file_path: { data_type: 'string', required: true } } },
    },
  });
  auth = { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
  nodeUrn = 'mta-org::mta-tasks::tasks:needs-file';
});

describe('#317 — hadron_run_task delegates the refusal', () => {
  it('a missing required argument is refused, naming it; nothing renders', async () => {
    const text = await createTestableMcpServer(auth).callToolText('hadron_run_task', { urn: nodeUrn, args: {} });
    expect(text).toContain('file_path');
    expect(text.toLowerCase()).toMatch(/required/);
    expect(text).not.toContain('# Node: needs-file');
  });

  it('the supplied argument renders as before', async () => {
    const text = await createTestableMcpServer(auth).callToolText('hadron_run_task', {
      urn: nodeUrn,
      args: { file_path: 'a.txt' },
    });
    expect(text).toContain('Process a.txt');
  });
});
