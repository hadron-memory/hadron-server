/**
 * #1328 — the separately maintained MCP writers take the same attestation
 * check as GraphQL, and no MCP tool reaches the trusted portal path.
 */
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
let configId: string;
/** A sign-in JWT, the credential the portal holds: over MCP it earns nothing. */
const auth = () => ({ userId, roles: ['ADMIN'], clientId: `user:${userId}`, signInCredential: true }) as unknown as AuthContext;
const urn = (loc: string) => `hrn:node:attest-mcp:mem:${loc}`;
const claim = (revision = 1) => ({ task: taskId, revision });
const stored = (loc: string) => db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc, memoryId } } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'attest-mcp', urn: 'attest-mcp' } });
  userId = (await db.user.create({ data: { githubId: 13281, githubUsername: 'attest-mcp', handle: 'attest-mcp' } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'attest-mcp:mem', name: 'mem', class: 'knowledge' } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'task', name: 'Task', isRunnable: true } })).id;
  configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
});

describe('#1328 MCP parity', () => {
  it('hadron_create_node and hadron_update_node refuse without a write and stamp a match', async () => {
    const srv = createTestableMcpServer(auth());
    expect(await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one' }))
      .toMatch(/authoring_attestation_missing/);
    expect(await db.node.count({ where: { memoryId, loc: 'a' } })).toBe(0);
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    const first = await stored('a');
    expect(first).toMatchObject({ authorshipKind: 'TASK', authoredByTask: taskId, authoredByRevision: 1 });
    await db.node.update({ where: { id: taskId }, data: { revSeq: 2 } });
    expect(await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: claim(1) }))
      .toMatch(/authoring_attestation_stale/);
    expect(await db.nodeRevision.count({ where: { nodeId: first.id } })).toBe(0);
    await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'two', authoredWith: claim(2) });
    expect(await stored('a')).toMatchObject({ content: 'two', authoredByTask: taskId, authoredByRevision: 2 });
  });

  it('an upsert over a live governed node attests, and an identical one does not', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    await srv.callToolText('hadron_update_node', { urn: urn('a'), content: 'one' });
    expect(await stored('a')).toMatchObject({ authoredByTask: taskId });
  });

  it('hadron_update_node_data forwards the claim to the shared seam', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    expect(await srv.callToolText('hadron_update_node_data', { urn: urn('a'), data: { k: 1 } })).toMatch(/authoring_attestation_missing/);
    await srv.callToolText('hadron_update_node_data', { urn: urn('a'), data: { k: 1 }, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ data: { k: 1 }, authoredByTask: taskId });
  });

  it('hadron_replace_text forwards the claim and refuses as one batch', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'alpha', authoredWith: claim() });
    const args = { nodeUrns: [urn('a')], oldText: 'alpha', newText: 'beta', fields: ['content'] };
    expect(await srv.callToolText('hadron_replace_text', args)).toMatch(/authoring_attestation_missing/);
    expect((await stored('a')).content).toBe('alpha');
    await srv.callToolText('hadron_replace_text', { ...args, authoredWith: claim() });
    expect(await stored('a')).toMatchObject({ content: 'beta', authoredByTask: taskId });
  });

  it('hadron_create_parent_node re-saving a governed section attests', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('section'), name: 'S', role: 'guide', content: 'one', authoredWith: claim() });
    const args = { urn: urn('section'), name: 'Renamed', content: 'two' };
    expect(await srv.callToolText('hadron_create_parent_node', args)).toMatch(/authoring_attestation_missing/);
    expect(await stored('section')).toMatchObject({ content: 'one', name: 'S' });
    await srv.callToolText('hadron_create_parent_node', { ...args, authoredWith: claim() });
    expect(await stored('section')).toMatchObject({ content: 'two', authoredByTask: taskId });
  });

  it('the review door takes the claim, so the generic refusal does not trap an agent', async () => {
    await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'review', authorTaskId: taskId, authorTaskRequired: true } });
    const srv = createTestableMcpServer(auth());
    expect(await srv.callToolText('hadron_create_review', { urn: urn('r'), name: 'R', content: 'check' }))
      .toMatch(/authoring_attestation_missing/);
    await srv.callToolText('hadron_create_review', { urn: urn('r'), name: 'R', content: 'check', authoredWith: claim() });
    expect(await stored('r')).toMatchObject({ role: 'review', authoredByTask: taskId });
  });

  it('a rename on move is an authored name change and attests; a plain move carries', async () => {
    const srv = createTestableMcpServer(auth());
    await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'guide', content: 'one', authoredWith: claim() });
    await srv.callToolText('hadron_move_node', { urn: urn('a'), targetUrn: urn('b') });
    expect(await stored('b')).toMatchObject({ name: 'A', authoredByTask: taskId });
    expect(await srv.callToolText('hadron_move_node', { urn: urn('b'), targetUrn: urn('c'), renameToLeaf: true }))
      .toMatch(/authoring_attestation_missing/);
    expect(await stored('b')).toMatchObject({ name: 'A' });
    await srv.callToolText('hadron_move_node', { urn: urn('b'), targetUrn: urn('c'), renameToLeaf: true, authoredWith: claim() });
    expect(await stored('c')).toMatchObject({ name: 'c', authoredByTask: taskId });
  });
});
