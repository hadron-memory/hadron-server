/**
 * #1701 / #1702 QA case 8 — a tool call's `session` argument is ATTRIBUTION
 * ONLY, never reach.
 *
 * For a pure App key, the X-Hadron-Session header binding (`auth.sessionId`)
 * changes what the key may touch: it isolates the key to the session's scope,
 * and it is the ONLY way such a key writes the session's bound memory (the
 * anonymous scratch memory startAgentSession provisions). The per-call
 * `session` argument the #1701 gate added is validated by the same
 * validateSessionBinding check but must stay on the attribution side: it
 * publishes the session's actor and never sets `auth.sessionId`. These tests
 * pin that in both directions, plus the foreign-App refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { canWriteToMemory } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'reach-org', urn: 'reach-org' } })).id;
});

/** An App with its agent installed, and one anonymous end-user session bound to its own scratch memory. */
async function appWithSession(slug: string) {
  const agent = await db.agent.create({
    data: { id: generateId(), name: `${slug} agent`, urn: `${orgId}:${slug}-agent`, organizationId: orgId },
  });
  const { app } = await createDbAppWithKey(db, slug, orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const session = async (tag: string) => {
    const memory = await db.memory.create({
      data: {
        class: 'app', id: generateId(), name: `${slug} ${tag}`, urn: `${orgId}:${slug}-${tag}`,
        organizationId: orgId, appId: app.id, userMemoryOfAgentId: agent.id,
      },
    });
    const row = await db.session.create({
      data: { id: generateId(), appId: app.id, agentId: agent.id, memoryId: memory.id },
    });
    return { memory, session: row };
  };
  return { app, agent, session };
}

const appKey = (appId: string, sessionId?: string): AuthContext =>
  ({ appId, organizationId: orgId, roles: [], clientId: `app:${appId}`, ...(sessionId ? { sessionId } : {}) }) as AuthContext;

const nodeIn = (memoryId: string, loc: string) => db.node.findFirst({ where: { memoryId, loc } });

describe('#1701 case 8: the session ARGUMENT attributes, it never grants reach', () => {
  it('control: only the header-bound App key may write the session\'s scratch memory', async () => {
    const { app, session } = await appWithSession('ctl');
    const s = await session('s');
    expect(await canWriteToMemory(db, appKey(app.id, s.session.id), s.memory.id)).toBe(true);
    expect(await canWriteToMemory(db, appKey(app.id), s.memory.id)).toBe(false);
  });

  it('an UNBOUND App key naming its session in the call still cannot write that session\'s memory', async () => {
    const { app, session } = await appWithSession('unbound');
    const s = await session('s');
    const text = await createTestableMcpServer(appKey(app.id)).callToolText('hadron_create_node', {
      urn: `hrn:node:${orgId}:unbound-s:widened`, name: 'widened', session: s.session.id,
    });
    // The session VALIDATES (it is the App's own), so the refusal is the
    // access gate's, not the session gate's: reach stayed the key's own.
    expect(text).not.toContain('[session_not_bound]');
    expect(await nodeIn(s.memory.id, 'widened')).toBeNull();
  });

  it('a key BOUND to one session cannot reach a sibling session\'s memory by naming it in the call', async () => {
    const { app, session } = await appWithSession('bound');
    const mine = await session('mine');
    const theirs = await session('theirs');
    const server = createTestableMcpServer(appKey(app.id, mine.session.id));
    await server.callToolText('hadron_create_node', {
      urn: `hrn:node:${orgId}:bound-theirs:crossed`, name: 'crossed', session: theirs.session.id,
    });
    expect(await nodeIn(theirs.memory.id, 'crossed')).toBeNull();
    // Its own bound memory is still writable, and the write is credited to
    // the session it names.
    await server.callToolText('hadron_create_node', {
      urn: `hrn:node:${orgId}:bound-mine:own`, name: 'own', session: mine.session.id,
    });
    expect(await nodeIn(mine.memory.id, 'own')).not.toBeNull();
  });

  it('another App\'s session is refused outright and nothing is written', async () => {
    const a = await appWithSession('appa');
    const b = await appWithSession('appb');
    const foreign = await b.session('s');
    const text = await createTestableMcpServer(appKey(a.app.id)).callToolText('hadron_create_node', {
      urn: `hrn:node:${orgId}:appb-s:foreign`, name: 'foreign', session: foreign.session.id,
    });
    expect(text).toContain('[session_not_bound]');
    expect(await nodeIn(foreign.memory.id, 'foreign')).toBeNull();
  });
});
