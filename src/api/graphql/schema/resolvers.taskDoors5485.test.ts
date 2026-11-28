/**
 * #5485 Ask 1 — the task doors write the role `task` when the caller gives none, and retiring a task through its
 * door leaves no task-family role behind (the database refuses one on a row that is not runnable).
 * `isRunnable` still governs: it is what makes a node a task for role rules, running and governance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ruleKeysOf } from '../../../lib/nodeRoleWriters.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let memoryId: string;
let adminId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const at = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc } });
const mcp = () => createTestableMcpServer({ userId: adminId, roles: ['ADMIN'] as never, clientId: `user:${adminId}` });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message; } };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'door-org', urn: 'door-org.test' } });
  adminId = (await db.user.create({ data: { id: generateId(), githubId: 548510, githubUsername: 'door-admin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: adminId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: 'corpus' }, ctx())).id;
});

describe('#5485 createTaskNode', () => {
  it('writes role task when the caller gives none', async () => {
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'a', name: 'a', isRunnable: true } }, ctx());
    expect(await at('a')).toMatchObject({ isRunnable: true, role: 'task' });
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'b', name: 'b', isRunnable: true, role: null } }, ctx());
    expect(await at('b')).toMatchObject({ isRunnable: true, role: 'task' });
  });

  it('keeps a role the caller gives', async () => {
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'c', name: 'c', isRunnable: true, role: 'task.role' } }, ctx());
    expect(await at('c')).toMatchObject({ isRunnable: true, role: 'task.role' });
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'd', name: 'd', isRunnable: true, role: 'review' } }, ctx());
    expect(await at('d')).toMatchObject({ isRunnable: true, role: 'review' });
  });
});

describe('#5485 hadron_create_task', () => {
  it('writes role task when the caller gives none, and keeps one it is given', async () => {
    const urn = (loc: string) => `hrn:node:door-org.test:corpus:${loc}`;
    await mcp().callToolText('hadron_create_task', { urn: urn('m1'), name: 'm1' });
    expect(await at('m1')).toMatchObject({ isRunnable: true, role: 'task' });
    await mcp().callToolText('hadron_create_task', { urn: urn('m2'), name: 'm2', role: 'task.role' });
    expect(await at('m2')).toMatchObject({ isRunnable: true, role: 'task.role' });
  });
});

describe('#5485 retiring a task through its door', () => {
  it('clears the task-family role with isRunnable, and a role the caller gives for the retired node is kept', async () => {
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'r', name: 'r', isRunnable: true } }, ctx());
    expect(await code(M.updateTaskNode({}, { input: { memoryRef: memoryId, loc: 'r', isRunnable: false } }, ctx()))).toBe('OK');
    expect(await at('r')).toMatchObject({ isRunnable: false, role: null });
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 's', name: 's', isRunnable: true } }, ctx());
    expect(await code(M.updateTaskNode({}, { input: { memoryRef: memoryId, loc: 's', isRunnable: false, role: 'notes' } }, ctx()))).toBe('OK');
    expect(await at('s')).toMatchObject({ isRunnable: false, role: 'notes' });
  });

  it('a generic update cannot clear isRunnable from a task node and leave the role', async () => {
    await M.createTaskNode({}, { input: { memoryRef: memoryId, loc: 'g', name: 'g', isRunnable: true } }, ctx());
    expect(await code(M.updateNode({}, { input: { ref: (await at('g')).id, isRunnable: false } }, ctx()))).toBe('ROLE_GOVERNED');
    expect(await at('g')).toMatchObject({ isRunnable: true, role: 'task' });
  });
});

describe('#5485 isRunnable still decides the role rules', () => {
  it('a runnable node is judged under the task rule once whether or not its role is task', () => {
    expect(ruleKeysOf('task', true)).toEqual(['task']);
    expect(ruleKeysOf('task.role', true)).toEqual(['task.role', 'task']);
    expect(ruleKeysOf(null, true)).toEqual(['task']);
    expect(ruleKeysOf('task', false)).toEqual(['task']);
  });
});
