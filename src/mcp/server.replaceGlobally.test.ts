/**
 * hadron_replace_text — MCP surface for bulk search-and-replace. The tool
 * delegates to the GraphQL searchReplaceInNodes resolver (so the write
 * invariants are tested in resolvers.searchReplace.test.ts); this file covers
 * the MCP-specific concerns: URN-based selection, the dryRun-vs-write text
 * rendering, permission gating, and error surfacing as textResult.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let viewer: { id: string };
let memory: { id: string; urn: string };

function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}
function viewerAuth(): AuthContext {
  return { userId: viewer.id, roles: [], clientId: `user:${viewer.id}` };
}
function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

async function makeNode(loc: string, fields: Record<string, unknown>) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, ...fields },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'rg-org', urn: 'rg-org' },
  });
  admin = await db.user.create({
    data: { githubId: 5551, githubUsername: 'rg-admin', roles: ['ADMIN'] },
  });
  viewer = await db.user.create({
    data: { githubId: 5552, githubUsername: 'rg-viewer', roles: [] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'rg-mem' }, adminCtx());
});

describe('hadron_replace_text', () => {
  it('dryRun reports matches without writing and labels the preview', async () => {
    const a = await makeNode('a', { content: 'cat cat' });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      memoryUrns: [memory.urn],
      fields: ['content'],
      dryRun: true,
    });

    expect(text).toMatch(/Would replace 2 occurrence/i);
    expect(text).toMatch(/dry run/i);
    expect(text).toMatch(/hrn:node:.*rg-mem:a/); // canonical URN-addressed line
    expect((await db.node.findUnique({ where: { id: a.id } }))?.content).toBe('cat cat');
  });

  it('writes the replacement across a memory and renders a per-node summary', async () => {
    const a = await makeNode('a', { content: 'the cat', tags: ['cat', 'pet'] });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      memoryUrns: [memory.urn],
      fields: ['content', 'tags'],
    });

    expect(text).toMatch(/^Replaced 2 occurrence/i);
    expect(text).toMatch(/content×1/);
    expect(text).toMatch(/tags×1/);

    const updated = await db.node.findUnique({ where: { id: a.id } });
    expect(updated?.content).toBe('the dog');
    expect(updated?.tags).toEqual(['dog', 'pet']);
  });

  it('selects an explicit node URN', async () => {
    const a = await makeNode('topic:a', { content: 'cat' });
    await makeNode('topic:b', { content: 'cat' });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      nodeUrns: [a.id], // ID-shape values are accepted alongside URNs
      fields: ['content'],
    });
    expect(text).toMatch(/across 1 of 1 node/i);
    expect((await db.node.findUnique({ where: { id: a.id } }))?.content).toBe('dog');
  });

  it.each([true, false])(
    'reports an all-skipped governed selection without changing it (dryRun=%s)',
    async (dryRun) => {
      const governed = await makeNode('governed', { content: 'cat stays', role: 'review' });
      const srv = createTestableMcpServer(adminAuth());
      const text = await srv.callToolText('hadron_replace_text', {
        oldText: 'cat',
        newText: 'dog',
        nodeUrns: [governed.id],
        fields: ['content'],
        dryRun,
      });

      expect(text).toContain('0 of 0 node(s) scanned');
      expect(text).toContain(
        'Coverage: 1 selected; 0 scanned; 1 skipped/protected (1 governed, 0 protected address).',
      );
      expect((await db.node.findUniqueOrThrow({ where: { id: governed.id } })).content).toBe(
        'cat stays',
      );
      expect(await db.nodeRevision.count({ where: { nodeId: governed.id } })).toBe(0);
    },
  );

  it('distinguishes a memory-prefix no-match scan from a governed skip', async () => {
    await makeNode('scope:ordinary', { content: 'no match here' });
    await makeNode('scope:governed', { content: 'cat stays', isRunnable: true });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      memoryUrns: [memory.urn],
      prefix: 'scope',
      fields: ['content'],
      dryRun: true,
    });

    expect(text).toContain('0 of 1 node(s) scanned');
    expect(text).toContain(
      'Coverage: 2 selected; 1 scanned; 1 skipped/protected (1 governed, 0 protected address).',
    );
  });

  it('reports a protected Channel address separately', async () => {
    const { rootId } = await ensureChannelWithRoot(db, {
      memoryId: memory.id,
      loc: 'protected',
      name: 'protected',
      createdBy: admin.id,
    });
    await db.node.update({ where: { id: rootId }, data: { content: 'cat stays' } });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      nodeUrns: [rootId],
      fields: ['content'],
    });

    expect(text).toContain(
      'Coverage: 1 selected; 0 scanned; 1 skipped/protected (0 governed, 1 protected address).',
    );
    expect((await db.node.findUniqueOrThrow({ where: { id: rootId } })).content).toBe('cat stays');
  });

  it('returns a graceful error (not a throw) when write access is denied', async () => {
    await makeNode('a', { content: 'cat' });
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: 'cat',
      newText: 'dog',
      memoryUrns: [memory.urn],
      fields: ['content'],
    });
    expect(text).toMatch(/error/i);
    expect(text).toMatch(/forbidden|access/i);
    expect(text).not.toMatch(/selected|skipped|governed/i);
  });

  it('surfaces an invalid-regex error as text', async () => {
    await makeNode('a', { content: 'cat' });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_replace_text', {
      oldText: '(',
      newText: 'x',
      memoryUrns: [memory.urn],
      fields: ['content'],
      regex: true,
    });
    expect(text).toMatch(/invalid search pattern/i);
  });
});
