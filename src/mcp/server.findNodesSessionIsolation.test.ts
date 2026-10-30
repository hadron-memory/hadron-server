/**
 * #403 (PR2) — session-isolation of hadron_find_nodes for App-Key + active-session
 * callers.
 *
 * hadron_find_nodes now delegates to resolvers.Query.findNodes, whose
 * getAccessibleMemoryIds hard-isolates an App-Key + active-session caller to the
 * session's memory (+ the agent's system memory) — THE security boundary for
 * multi-user agents (checked ahead of any role). The MCP pre-scope memoryUrn /
 * parentRel gates use canReadMemory. The point-read map now applies the same
 * session scope; the extra pre-scope check preserves the not-found envelope
 * for a denied or absent selector (PR #404 review, Copilot).
 *
 * This file pins: (1) an out-of-session memoryUrn/parentRel returns the "not
 * found" envelope, indistinguishable from a genuinely-absent memory; (2) the
 * session's own memory still resolves and returns its nodes; (3) a broad
 * (unscoped) search only surfaces the session's memory, never a sibling memory
 * the App-Key can otherwise read.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbNode } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, filterReadableMemoryIds } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

interface Fixture {
  appId: string;
  sessionId: string;
  sessionMemory: { id: string; urn: string };
  siblingMemory: { id: string; urn: string };
}

let fx: Fixture;

function appSessionAuth(): AuthContext {
  // App-Key + active session — no userId, no roles.
  return { appId: fx.appId, sessionId: fx.sessionId, organizationId: undefined };
}

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'i403-org', urn: 'i403-org' },
  });

  const mkMemory = async (slug: string, cls: string) =>
    db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}::${slug}`,
        name: slug,
        class: cls as never,
      },
    });

  // The session's memory, a sibling the agent can ALSO read, and the agent's
  // system memory. All three are reachable via getAppMemoryAccess (so
  // canReadMemory says yes to each), but only the session memory + system
  // memory are inside the session boundary.
  const sessionMemory = await mkMemory('session-mem', 'knowledge');
  const siblingMemory = await mkMemory('sibling-mem', 'knowledge');
  const systemMemory = await mkMemory('agent-sys', 'system');

  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::i403-agent`,
      name: 'i403 agent',
      visibility: 'PUBLIC',
      systemMemoryId: systemMemory.id,
      memoryItems: {
        create: [
          { memoryId: sessionMemory.id, role: 'read' },
          { memoryId: siblingMemory.id, role: 'read' },
        ],
      },
    },
  });

  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}::i403-app`,
      name: 'i403 app',
      appAgents: { create: { agentId: agent.id } },
    },
  });

  // #1376: an item never admits a userless key's session; the session memory is the App's own (tied to it).
  await db.memory.update({ where: { id: sessionMemory.id }, data: { appId: app.id } });

  const session = await db.session.create({
    data: {
      id: generateId(),
      appId: app.id,
      agentId: agent.id,
      memoryId: sessionMemory.id,
    },
  });

  await createDbNode(db, {
    memoryId: sessionMemory.id,
    loc: 'alpha-session',
    name: 'alpha in the session memory',
  });
  await createDbNode(db, {
    memoryId: siblingMemory.id,
    loc: 'alpha-sibling',
    name: 'alpha in the sibling memory',
  });

  fx = {
    appId: app.id,
    sessionId: session.id,
    sessionMemory: { id: sessionMemory.id, urn: sessionMemory.urn },
    siblingMemory: { id: siblingMemory.id, urn: siblingMemory.urn },
  };
});

describe('#403 — hadron_find_nodes session isolation (App-Key + active session)', () => {
  it('memoryUrn scoped to a sibling (App-readable but out-of-session) returns "Memory not found"', async () => {
    expect(await canReadMemory(db, appSessionAuth(), fx.sessionMemory.id)).toBe(true);
    expect(await canReadMemory(db, appSessionAuth(), fx.siblingMemory.id)).toBe(false);
    // A caller's wider App fold must not override the bound session in either
    // point or batch reads.
    const appFold = new Map([[fx.siblingMemory.id, 'READ_WRITE']]);
    expect(await canReadMemory(db, appSessionAuth(), fx.siblingMemory.id,
      { access: appFold })).toBe(false);
    expect(await filterReadableMemoryIds(db, appSessionAuth(),
      [fx.sessionMemory.id, fx.siblingMemory.id], { access: appFold }))
      .toEqual(new Set([fx.sessionMemory.id]));
    const srv = createTestableMcpServer(appSessionAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: fx.siblingMemory.urn,
    });
    // Same envelope as a genuinely-absent memory — no existence/oracle leak,
    // and NOT the misleading "No nodes found".
    expect(text).toContain('Memory not found or invalid');
    expect(text).not.toContain('alpha-sibling');
  });

  it('memoryUrn scoped to the session memory resolves and returns its nodes (control)', async () => {
    const srv = createTestableMcpServer(appSessionAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      memoryUrn: fx.sessionMemory.urn,
    });
    expect(text).not.toContain('Memory not found');
    expect(text).toContain('alpha-session');
  });

  it('parentRel resolving into a sibling memory returns the "not found" envelope', async () => {
    const srv = createTestableMcpServer(appSessionAuth());
    const text = await srv.callToolText('hadron_find_nodes', {
      query: 'alpha',
      parentRel: `urn:node:${fx.siblingMemory.urn}::alpha-sibling`,
    });
    expect(text).toMatch(/no nodes found/i);
    expect(text).not.toContain('alpha in the sibling memory');
  });

  it('a broad (unscoped) search only surfaces the session memory, never the sibling', async () => {
    const srv = createTestableMcpServer(appSessionAuth());
    const text = await srv.callToolText('hadron_find_nodes', { query: 'alpha' });
    expect(text).toContain('alpha-session');
    expect(text).not.toContain('alpha-sibling');
  });
});
