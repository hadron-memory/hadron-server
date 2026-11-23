/**
 * #317 acceptance 6 — the required-argument refusal reaches MCP `hadron_run_task`
 * through its delegation to `Mutation.runTask` (no second implementation). The
 * delegation exists in EXECUTE mode (`appRef`); the default render mode builds its
 * own bundle (`runBundleResult`, shared with `hadron_run_action`) and is the open
 * question on the issue thread.
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
let appId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'mta-org', urn: 'mta-org' } });
  const admin = await db.user.create({ data: { githubId: 3173, githubUsername: 'mta-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'mta-app', urn: 'mta-org::mta-app' } })).id;
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

describe('#317 — hadron_run_task (execute mode, appRef) delegates the refusal to Mutation.runTask', () => {
  it('a missing required argument is refused, naming it; no AppRun is minted', async () => {
    const text = await createTestableMcpServer(auth).callToolText('hadron_run_task', { urn: nodeUrn, args: {}, appRef: appId });
    expect(text).toContain('Missing required task argument');
    expect(text).toContain('file_path');
    expect(text).not.toContain('Run started');
    expect(await db.appRun.count()).toBe(0);
  });

  it('with the argument supplied the call is not refused for it (it proceeds to the run path)', async () => {
    const text = await createTestableMcpServer(auth).callToolText('hadron_run_task', {
      urn: nodeUrn,
      args: { file_path: 'a.txt' },
      appRef: appId,
    });
    expect(text).not.toContain('Missing required task argument');
    // It reached the run path: the refusal that comes next is the existing one (no served agent here), not the argument refusal.
    expect(text).toContain('Could not start run');
    expect(text).toMatch(/No boot prompt/i);
  });
});
