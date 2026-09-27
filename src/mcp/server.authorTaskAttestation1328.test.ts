/** #1328 — MCP create/update use the same author-task policy as GraphQL. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let userId: string;
let memoryId: string;
let taskId: string;
const auth = (): AuthContext => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const urn = (loc: string) => `hrn:node:attest-mcp:mem:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-mcp', urn: 'attest-mcp' } });
  userId = (await db.user.create({ data: { githubId: 13281, githubUsername: 'attest-mcp', handle: 'attest-mcp' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'attest-mcp:mem', name: 'mem', class: 'knowledge' } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true } })).id;
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#1328 MCP author-task parity', () => {
  it('create and update refuse missing/stale assertions and stamp matching writes', async () => {
    const srv = createTestableMcpServer(auth());
    expect(await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one' }))
      .toMatch(/^\[author_task_missing\]/);
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    expect(await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: { task: taskId, revision: 1 } }))
      .toMatch(/Node saved/);
    const first = await db.node.findFirstOrThrow({ where: { memoryId, loc: 'a' } });
    expect(first).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: { task: taskId, revision: 1 } }))
      .toMatch(/^\[author_task_stale_revision\]/);
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
    expect(await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: { task: taskId, revision: 2 } }))
      .toMatch(/Node updated/);
    expect(await db.node.findUniqueOrThrow({ where: { id: first.id } }))
      .toMatchObject({ content: 'two', authoredByTask: taskId, authoredByRevision: 2 });
  });
});
