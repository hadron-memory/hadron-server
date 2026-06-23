/**
 * GraphQL runTask resolver tests (spec cor:api:060).
 * Mirrors the behavior of the MCP hadron_run_task tool but through the GraphQL API.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { GraphQLError } from 'graphql';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Mem {
  id: string;
  urn: string;
  name: string;
}

interface Fixture {
  admin: { id: string };
  alpha: Mem;
}

let fx: Fixture;

// Helper to compose a full node URN (convert memory URN to node URN format).
function nodeUrnOf(mem: Mem, loc: string): string {
  const i = mem.urn.indexOf(':');
  return `${mem.urn.slice(0, i)}::${mem.urn.slice(i + 1)}::${loc}`;
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'run-task-gql-org', urn: 'run-task-gql-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 8801, githubUsername: 'rt-gql-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const ctx: Context = { db, roles: ['ADMIN'], userId: admin.id };

  // Create a memory via the GraphQL resolver to get the proper URN format.
  const memData = (await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'Alpha' },
    ctx,
  )) as { id: string };

  // Retrieve the memory with its stored URN.
  const mem = await db.memory.findUniqueOrThrow({
    where: { id: memData.id },
    select: { id: true, urn: true, name: true },
  });

  const taskNode = await db.node.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      loc: 'tasks:deploy',
      name: 'Deploy App',
      nodeType: 'task',
      content: 'Run: npm run deploy',
      isRunnable: true,
      tags: [],
    },
  });

  const depNode = await db.node.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      loc: 'docs:notes',
      name: 'Release Notes',
      nodeType: 'info',
      content: 'See the release notes before deploying.',
      isRunnable: false,
      tags: [],
    },
  });

  await db.edge.create({
    data: {
      id: generateId(),
      memoryId: mem.id,
      sourceId: taskNode.id,
      targetId: depNode.id,
      loc: deriveEdgeLoc(taskNode.loc, 'requires', depNode.loc),
      name: 'requires',
    },
  });

  fx = {
    admin,
    alpha: mem,
  };
});

describe('GraphQL runTask mutation', () => {
  it('runs a task by exact name when the memory is specified', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    const result = await resolvers.Mutation.runTask(
      {},
      { task: 'Deploy App', memory: 'Alpha' },
      ctx,
    );
    expect(result).toContain('# Node: Deploy App');
    expect(result).toContain('Run: npm run deploy');
    expect(result).toContain('# Referenced Nodes');
    expect(result).toContain('Release Notes');
  });

  it('runs a task with Mustache template compilation', async () => {
    // Create a node with a Mustache template
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.alpha.id,
        loc: 'tasks:greet',
        name: 'Greet user',
        nodeType: 'task',
        content: 'Say hello to {{name}}! You are {{title}}.',
        isRunnable: true,
        tags: [],
      },
    });

    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    const result = await resolvers.Mutation.runTask(
      {},
      { task: 'Greet user', memory: 'Alpha', args: { name: 'Alice', title: 'awesome' } },
      ctx,
    );
    expect(result).toContain('Say hello to Alice! You are awesome.');
  });

  it('runs a task with conditional Mustache template', async () => {
    // Create a node with conditional template logic
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.alpha.id,
        loc: 'tasks:conditional',
        name: 'Conditional task',
        nodeType: 'task',
        content: '{{#admin}}Admin actions available{{/admin}}{{^admin}}User actions only{{/admin}}',
        isRunnable: true,
        tags: [],
      },
    });

    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };

    // With admin=1 (truthy)
    const resultAdmin = await resolvers.Mutation.runTask(
      {},
      { task: 'Conditional task', memory: 'Alpha', args: { admin: '1' } },
      ctx,
    );
    expect(resultAdmin).toContain('Admin actions available');

    // Without admin parameter (falsy - treated as undefined)
    const resultUser = await resolvers.Mutation.runTask(
      {},
      { task: 'Conditional task', memory: 'Alpha' },
      ctx,
    );
    expect(resultUser).toContain('User actions only');
  });

  it('runs a task by full URN without memory resolution', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    const urn = nodeUrnOf(fx.alpha, 'tasks:deploy');
    const result = await resolvers.Mutation.runTask({}, { urn }, ctx);
    expect(result).toContain('# Node: Deploy App');
    expect(result).toContain('Run: npm run deploy');
  });

  it('rejects an invalid URN', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    try {
      await resolvers.Mutation.runTask({}, { urn: 'not-a-urn' }, ctx);
      expect.fail('Expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions.code).toBe('UrnNotQualifiedError');
    }
  });

  it('errors when no task matches the hint', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    try {
      await resolvers.Mutation.runTask(
        {},
        { task: 'Nonexistent', memory: 'Alpha' },
        ctx,
      );
      expect.fail('Expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions.code).toBe('NOT_FOUND');
      expect((e as GraphQLError).message).toContain('No runnable task');
    }
  });

  it('errors when the memory is not found', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    try {
      await resolvers.Mutation.runTask(
        {},
        { task: 'Deploy App', memory: 'Nonexistent' },
        ctx,
      );
      expect.fail('Expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions.code).toBe('NOT_FOUND');
      expect((e as GraphQLError).message).toContain('No memory matching');
    }
  });

  it('only matches runnable nodes (isRunnable=true)', async () => {
    // Create a task that is not runnable
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: fx.alpha.id,
        loc: 'tasks:notes',
        name: 'Task Notes',
        nodeType: 'task',
        content: 'Just a note',
        isRunnable: false,
        tags: [],
      },
    });

    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    try {
      await resolvers.Mutation.runTask(
        {},
        { task: 'Task Notes', memory: 'Alpha' },
        ctx,
      );
      expect.fail('Expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).extensions.code).toBe('NOT_FOUND');
    }
  });

  it('records a usage event on successful run', async () => {
    const ctx: Context = { db, roles: ['ADMIN'], userId: fx.admin.id };
    await resolvers.Mutation.runTask(
      {},
      { task: 'Deploy App', memory: 'Alpha' },
      ctx,
    );

    // Check that a usage event was recorded (fire-and-forget, so it may not be instant).
    // Give it a moment to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const event = await db.usageEvent.findFirst({
      where: { type: 'action-run', nodeLoc: 'tasks:deploy' },
    });
    expect(event).toBeDefined();
    expect(event?.type).toBe('action-run');
  });
});
