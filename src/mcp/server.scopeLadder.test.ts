/**
 * Spec 049 Phase 3 — the search ladder on MCP, where the AMBIENT rungs live.
 *
 * Pinned: with no memory selector, hadron_find_nodes runs under the active App
 * (`app`) and SAYS so; an explicit memoryUrn outranks the ambient rung (the
 * call every project's CLAUDE.md makes must keep working); `scope: "global"`
 * is the org view; hadron_set_active_scope is rung 2, persisted and restored
 * re-authorized; hadron_search carries the same line.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { loadMcpSessionState } from '../lib/mcpSessionState.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string };
let attached: { id: string; urn: string };
let other: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'sl', urn: `sl-${t}.com` } });
  user = await db.user.create({ data: { id: generateId(), githubId: 48401, githubUsername: `sl-u-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const mem = (slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  attached = await mem('attached');
  other = await mem('other');
  await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: attached.id, role: 'read' } });
  for (const m of [attached, other]) {
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'alpha', name: 'alpha', nodeType: 'info', content: 'alpha content' } });
  }
});

function server(clientKey: string | null = null, restoredScopeId?: string) {
  const auth = { userId: user.id, roles: ['READER'], clientId: `user:${user.id}`, appId: app.id, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `sl-${generateId()}`, clientKey, restoredScopeId, cachedAppResolution: { kind: 'multi-app' } });
}

describe('the ambient ladder on hadron_find_nodes', () => {
  it('with no memory selector the active App is the scope, and the result says so', async () => {
    const out = await server().callToolText('hadron_find_nodes', { query: '*' });
    expect(out).toContain(`scope: app hrn:app:${app.urn}`);
    expect(out).toContain('(via active-app)');
    expect(out).toContain(`hrn:node:${attached.urn}:alpha`);
    expect(out).not.toContain(`hrn:node:${other.urn}:alpha`);
  });

  it('an explicit memoryUrn OUTRANKS the ambient scope — the everyday call keeps working', async () => {
    const out = await server().callToolText('hadron_find_nodes', { query: '*', memoryUrn: `hrn:mem:${other.urn}` });
    expect(out).toContain(`hrn:node:${other.urn}:alpha`);
    expect(out).not.toContain('scope:');
  });

  it('`global` is the organization view; a named scope intersects with an explicit memory', async () => {
    const global = await server().callToolText('hadron_find_nodes', { query: '*', scope: 'global' });
    expect(global).toContain(`scope: global — organization hrn:org:${org.urn}`);
    expect(global).toContain(`hrn:node:${other.urn}:alpha`);
    const both = await server().callToolText('hadron_find_nodes', { query: '*', scope: 'app', memoryUrn: `hrn:mem:${other.urn}` });
    expect(both).toContain('Found 0 node(s) — the memories you named are outside this scope');
  });
});

describe('hadron_set_active_scope — rung 2, persisted, re-authorized', () => {
  it('sets by name in the active App, is used by the next search, survives a reconnect', async () => {
    const key = 'claude-desktop-1';
    const srv = server(key);
    await srv.callToolText('hadron_create_scope', { name: 'lens', memoryUrns: [`hrn:mem:${other.urn}`] });
    const set = await srv.callToolText('hadron_set_active_scope', { scope: 'lens' });
    expect(set).toContain('Active scope set to "lens"');
    const out = await srv.callToolText('hadron_find_nodes', { query: '*' });
    expect(out).toContain('scope: scope "lens"');
    expect(out).toContain('(via session)');
    expect(out).toContain(`hrn:node:${other.urn}:alpha`);
    expect(out).not.toContain(`hrn:node:${attached.urn}:alpha`);

    const restored = await loadMcpSessionState(db, { userId: user.id, roles: ['READER'], clientId: `user:${user.id}` } as AuthContext, key);
    expect(restored.activeScopeId).toBeDefined();
    const again = await server(key, restored.activeScopeId).callToolText('hadron_find_nodes', { query: '*' });
    expect(again).toContain('(via session)');

    // A scope named in the call still outranks the session's.
    const named = await srv.callToolText('hadron_find_nodes', { query: '*', scope: 'app' });
    expect(named).toContain('(via call)');
    expect(named).toContain(`hrn:node:${attached.urn}:alpha`);

    const cleared = await srv.callToolText('hadron_set_active_scope', { clear: true });
    expect(cleared).toContain('Active scope cleared');
    expect(cleared).toContain('(via active-app)');
  });

  it('the disclosure is on EVERY scoped return — a vector diagnostic included (Codex/Copilot on #1161)', async () => {
    const out = await server().callToolText('hadron_find_nodes', { query: 'alpha', mode: 'vector' });
    expect(out).toContain(`scope: app hrn:app:${app.urn}`);
    expect(out).toMatch(/\[(no_vector_index|embedding_unavailable)\]/);
  });

  it("a pure App key's `global` is its credential's organization, and reads no org knowledge (Codex/Copilot on #1161, #1376)", async () => {
    const srv = createTestableMcpServer({ appId: app.id, roles: [] } as AuthContext, { sessionId: `sl-${generateId()}` });
    const out = await srv.callToolText('hadron_find_nodes', { query: '*', scope: 'global' });
    expect(out).toContain(`scope: global — organization hrn:org:${org.urn}`);
    // #1376: a bare key reaches no org-owned ORGANIZATION knowledge, even through its Agent's item.
    expect(out).not.toContain(`hrn:node:${attached.urn}:alpha`);
  });

  it('hadron_search carries the same scope line', async () => {
    const out = await server().callToolText('hadron_search', { query: 'alpha', entityTypes: ['node'] });
    expect(out).toContain(`scope: app hrn:app:${app.urn}`);
    expect(out).toContain(attached.urn);
    expect(out).not.toContain(other.urn);
  });
});
