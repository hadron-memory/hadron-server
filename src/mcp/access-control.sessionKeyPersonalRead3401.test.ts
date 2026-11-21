/**
 * #3401 (ruling 0203, cor:acl:010:02 "acting on the owner's behalf", cor:acl:010:04): a pure App key bound to a
 * session reads the session person's personal or private session memory, on MCP exactly as on GraphQL, when
 *   - the memory's owner is the session's person,
 *   - that person's subscription to the memory's Agent is active,
 *   - the memory's App is non-NULL and is the session's App, and its Agent is the session's Agent,
 *   - the call is not impersonating and the session is live (re-validated every call, D1),
 * and a run principal never reaches a private memory (#1719 R5a, D3). Every refusal answers as an unknown memory
 * (D4). Writes are not widened.
 *
 * Both surfaces are driven with the SAME principal: MCP tools through `createTestableMcpServer(auth)`, GraphQL
 * through the resolvers with that auth as the context. The retained-transport D1 cases over real MCP HTTP live in
 * `server.sessionKeyPersonalRead3401.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentSubscription } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, explainWriteRefusal, filterReadableMemoryIds } from './access-control.js';
import { sessionScopedMemoryIds } from '../lib/auth/sessionScopedMemoryIds.js';
import { drainNodeUsage } from '../lib/usageRecorder.js';
import { getAccessibleMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let org: { id: string; urn: string };
let agentA: string;
let agentB: string;
let appX: string;
let appY: string;
let mia: string;
let leo: string;

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase().slice(-8);
  org = await db.organization.create({ data: { id: generateId(), name: 'p3401', urn: `p3401-${s}.test` } });
  agentA = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } })).id;
  agentB = (await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'B', urn: `${org.urn}:b` } })).id;
  appX = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } })).id;
  appY = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } })).id;
  for (const appId of [appX, appY]) {
    for (const agentId of [agentA, agentB]) await db.appAgent.create({ data: { appId, agentId } });
  }
  mia = (await db.user.create({ data: { id: generateId(), externalAppId: appX, externalId: 'mia', identityProvider: 'APP', handle: `mia-${s}` } })).id;
  leo = (await db.user.create({ data: { id: generateId(), externalAppId: appX, externalId: 'leo', identityProvider: 'APP', handle: `leo-${s}` } })).id;
  for (const user of [mia, leo]) {
    for (const agentId of [agentA, agentB]) await createDbAgentSubscription(db, user, agentId);
  }
});

/** A per-user session memory, shaped as startAgentSession provisions it, with one distinguishable node. */
async function sessionMemory(opts: { cls: 'personal' | 'private'; owner?: string; appId?: string | null; agentId?: string }) {
  const tag = generateId().toLowerCase().slice(-10);
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:${tag}`, name: `user memory ${tag}`,
      class: opts.cls, visibility: null, userId: opts.owner ?? mia, createdBy: opts.owner ?? mia,
      userMemoryOfAgentId: opts.agentId ?? agentA, appId: opts.appId === undefined ? appX : opts.appId,
    },
  });
  await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: 'diary', name: 'Diary', content: `diary-3401-${tag}` },
  });
  return { id: memory.id, urn: memory.urn, nodeUrn: `hrn:node:${memory.urn}:diary`, marker: `diary-3401-${tag}` };
}

async function session(memoryId: string, opts: { appId?: string; userId?: string; agentId?: string } = {}) {
  return (await db.session.create({
    data: {
      id: generateId(), appId: opts.appId ?? appX, userId: opts.userId ?? mia,
      agentId: opts.agentId ?? agentA, memoryId,
    },
  })).id;
}

const keyAuth = (sessionId?: string, extra: Partial<AuthContext> = {}): AuthContext =>
  ({ appId: appX, organizationId: org.id, roles: [], ...(sessionId ? { sessionId } : {}), ...extra }) as AuthContext;

type Mem = Awaited<ReturnType<typeof sessionMemory>>;

/** Every read surface, on one principal: true where the memory's node is reached. */
async function reach(auth: AuthContext, mem: Mem) {
  const mcp = createTestableMcpServer(auth);
  const ctx = { db, ...auth } as unknown as Context;
  const findArgs = { query: mem.marker, mode: 'keyword' };
  const gqlFind = await (resolvers.Query as any).findNodes(null, findArgs, ctx).catch(() => null);
  const gqlNode = await (resolvers.Query as any).node(null, { ref: mem.nodeUrn }, ctx).catch(() => null);
  return {
    mcpGate: await canReadMemory(db, auth, mem.id),
    mcpBatchGate: (await filterReadableMemoryIds(db, auth, [mem.id])).has(mem.id),
    mcpGetNode: (await mcp.callToolText('hadron_get_node', { urn: mem.nodeUrn })).includes(mem.marker),
    mcpGetNodes: (await mcp.callToolText('hadron_get_nodes', { refs: [mem.nodeUrn] })).includes(mem.marker),
    mcpListNodes: (await mcp.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${mem.urn}` })).includes('diary'),
    mcpFindNodes: (await mcp.callToolText('hadron_find_nodes', { query: mem.marker, memoryUrn: `hrn:mem:${mem.urn}` })).includes('diary'),
    mcpListMemories: (await mcp.callToolText('hadron_list_memories', {})).includes(mem.urn),
    gqlGate: (await getAccessibleMemoryIds(ctx)).includes(mem.id),
    gqlNode: gqlNode?.content === mem.marker,
    gqlFindNodes: JSON.stringify(gqlFind ?? null).includes(mem.marker),
  };
}

const all = (v: boolean) => ({
  mcpGate: v, mcpBatchGate: v, mcpGetNode: v, mcpGetNodes: v, mcpListNodes: v, mcpFindNodes: v, mcpListMemories: v,
  gqlGate: v, gqlNode: v, gqlFindNodes: v,
});

describe('#3401 owner-positive: the session key reads its person\'s session memory on BOTH surfaces', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`${cls}: every MCP and GraphQL read surface reaches it`, async () => {
      const mem = await sessionMemory({ cls });
      const sid = await session(mem.id);
      expect(await reach(keyAuth(sid), mem)).toEqual(all(true));
    });
  }

  it('hadron_get_node returns the node itself, not just a hit (keeps the D4 comparisons non-vacuous)', async () => {
    const mem = await sessionMemory({ cls: 'personal' });
    const sid = await session(mem.id);
    const text = await createTestableMcpServer(keyAuth(sid)).callToolText('hadron_get_node', { urn: mem.nodeUrn });
    expect(text).toContain(mem.marker);
  });
});

/** The answer hadron_get_node gives for a node in a memory that does not exist, with the URN normalised out. */
async function unknownAnswer(auth: AuthContext, mem: Mem) {
  const ghost = `${org.urn}:ghost${generateId().toLowerCase().slice(-6)}`;
  const text = await createTestableMcpServer(auth).callToolText('hadron_get_node', { urn: `hrn:node:${ghost}:diary` });
  return text.split(ghost).join(mem.urn);
}

/**
 * GraphQL `node(ref:)`'s whole answer (value, or error message and code), with `fromUrn` swapped for `toUrn`. `reach`
 * reads a throw as "not reached", which alone would pass a refusal that names the memory or the session (#4726 blind
 * P3), so D4 compares this answer for the refused memory with the answer for a memory that does not exist.
 */
async function gqlNodeAnswer(auth: AuthContext, nodeUrn: string, fromUrn: string, toUrn: string) {
  const ctx = { db, ...auth } as unknown as Context;
  const out = await (resolvers.Query as any).node(null, { ref: nodeUrn }, ctx).then(
    (v: unknown) => ({ value: v ?? null }),
    (e: { message?: string; extensions?: { code?: unknown } }) => ({ error: e.message, code: e.extensions?.code ?? null }),
  );
  return JSON.stringify(out).split(fromUrn).join(toUrn);
}

/** Refused on every surface, and both hadron_get_node and GraphQL node answer as an unknown memory (D4). */
async function expectRefused(auth: AuthContext, mem: Mem) {
  expect(await reach(auth, mem)).toEqual(all(false));
  const refused = await createTestableMcpServer(auth).callToolText('hadron_get_node', { urn: mem.nodeUrn });
  expect(refused).toBe(await unknownAnswer(auth, mem));
  const ghost = `${org.urn}:ghost${generateId().toLowerCase().slice(-6)}`;
  expect(await gqlNodeAnswer(auth, mem.nodeUrn, mem.urn, '<memory>'))
    .toBe(await gqlNodeAnswer(auth, `hrn:node:${ghost}:diary`, ghost, '<memory>'));
}

describe('#3401 refusals answer as an unknown memory on both surfaces', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`${cls}: no session bound (the key's App fold never holds it)`, async () => {
      const mem = await sessionMemory({ cls });
      await session(mem.id);
      await expectRefused(keyAuth(), mem);
    });

    it(`${cls}: another session of the same App, for another person`, async () => {
      const mem = await sessionMemory({ cls });
      await session(mem.id);
      const leoMem = await sessionMemory({ cls, owner: leo });
      await expectRefused(keyAuth(await session(leoMem.id, { userId: leo })), mem);
    });

    it(`${cls}: another App's session (the binding does not validate for this key)`, async () => {
      const mem = await sessionMemory({ cls });
      await expectRefused(keyAuth(await session(mem.id, { appId: appY })), mem);
    });

    it(`${cls}: a session for Leo whose row points at Mia's memory (cor:acl:010:04 S6)`, async () => {
      const mem = await sessionMemory({ cls });
      await expectRefused(keyAuth(await session(mem.id, { userId: leo })), mem);
    });

    for (const [name, data] of [
      ['revoked', { revokedAt: new Date() }],
      ['expired', { expiresAt: new Date(Date.now() - 60_000) }],
    ] as const) {
      it(`${cls}: a ${name} subscription`, async () => {
        const mem = await sessionMemory({ cls });
        const sid = await session(mem.id);
        await db.agentSubscription.update({ where: { userId_agentId: { userId: mia, agentId: agentA } }, data });
        await expectRefused(keyAuth(sid), mem);
      });
    }

    it(`${cls}: a foreign App's row, even with the session's Agent and person (D2)`, async () => {
      const mem = await sessionMemory({ cls, appId: appY });
      await expectRefused(keyAuth(await session(mem.id)), mem);
    });

    it(`${cls}: a NULL-app row whose Agent is the session's and installed in its App (D2, Vera's FIT)`, async () => {
      const mem = await sessionMemory({ cls, appId: null });
      await expectRefused(keyAuth(await session(mem.id)), mem);
      // Its owner still reads it directly, with no App.
      const owner = { userId: mia, roles: [] } as AuthContext;
      expect(await canReadMemory(db, owner, mem.id)).toBe(true);
      expect((await getAccessibleMemoryIds({ db, ...owner } as unknown as Context)).includes(mem.id)).toBe(true);
    });

    it(`${cls}: the session's App but another Agent's row (D2: App AND Agent)`, async () => {
      const mem = await sessionMemory({ cls, agentId: agentB });
      await expectRefused(keyAuth(await session(mem.id)), mem);
    });

    it(`${cls}: an impersonating context carrying the App and session (D3)`, async () => {
      const mem = await sessionMemory({ cls });
      const sid = await session(mem.id);
      const impersonation = { sessionId: generateId(), actorUserId: leo, orgId: org.id, expiresAt: new Date(Date.now() + 3_600_000) };
      await expectRefused(keyAuth(sid, { impersonation }), mem);
    });
  }

  it('private: a run principal carrying the App and the session (D3, #1719 R5a)', async () => {
    const mem = await sessionMemory({ cls: 'private' });
    const sid = await session(mem.id);
    await expectRefused(keyAuth(sid, { clientId: `run:${generateId()}` }), mem);
  });
});

describe('#3401 D1: the session is re-validated on every call', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`${cls}: an ended session reaches nothing`, async () => {
      const mem = await sessionMemory({ cls });
      const sid = await session(mem.id);
      expect((await reach(keyAuth(sid), mem)).mcpGetNode).toBe(true);
      await db.session.update({ where: { id: sid }, data: { endedAt: new Date() } });
      await expectRefused(keyAuth(sid), mem);
    });

    it(`${cls}: a session past its hard expiry reaches nothing`, async () => {
      const mem = await sessionMemory({ cls });
      const sid = await session(mem.id);
      await db.session.update({ where: { id: sid }, data: { expiresAt: new Date(Date.now() - 1_000) } });
      await expectRefused(keyAuth(sid), mem);
    });

    it(`${cls}: a dormant session reaches nothing`, async () => {
      const mem = await sessionMemory({ cls });
      const old = new Date(Date.now() - 3 * 86_400_000);
      await db.app.update({ where: { id: appX }, data: { sessionDormancyDays: 1 } });
      const sid = (await db.session.create({
        data: { id: generateId(), appId: appX, userId: mia, agentId: agentA, memoryId: mem.id, startedAt: old, updatedAt: old },
      })).id;
      await expectRefused(keyAuth(sid), mem);
      // #4726 blind P2-1: a refused read must not count as a drive, or the next call of the same retained
      // principal would find the session live again. Probe repeatedly, flush every usage write, then probe again.
      const mcp = createTestableMcpServer(keyAuth(sid));
      for (let i = 0; i < 3; i += 1) {
        expect(await mcp.callToolText('hadron_get_node', { urn: mem.nodeUrn })).not.toContain(mem.marker);
        await reach(keyAuth(sid), mem);
      }
      await drainNodeUsage(db);
      expect(await db.usageEvent.count({ where: { sessionId: sid, countsAsActivity: true } })).toBe(0);
      expect((await db.session.findUniqueOrThrow({ where: { id: sid } })).updatedAt).toEqual(old);
      await expectRefused(keyAuth(sid), mem);
    });
  }

  it('control for the dormant pins: the same probes on a LIVE session do record counted activity', async () => {
    // #4726 blind delta P2: "zero counted events" above means something only if these probes reach the
    // recorder at all. On a live session, hadron_get_node through the same testable server, and then the same reach(), each
    // leave counted events after the same flush.
    const mem = await sessionMemory({ cls: 'personal' });
    const sid = await session(mem.id);
    const mcp = createTestableMcpServer(keyAuth(sid));
    expect(await mcp.callToolText('hadron_get_node', { urn: mem.nodeUrn })).toContain(mem.marker);
    await drainNodeUsage(db);
    expect(await db.usageEvent.count({ where: { sessionId: sid, countsAsActivity: true } })).toBeGreaterThan(0);
    expect(await reach(keyAuth(sid), mem)).toEqual(all(true));
    await drainNodeUsage(db);
    expect(await db.usageEvent.count({ where: { sessionId: sid, countsAsActivity: true } })).toBeGreaterThan(0);
  });

  it('the shared predicate itself answers empty for an ended session (both surfaces call it)', async () => {
    const mem = await sessionMemory({ cls: 'personal' });
    const sid = await session(mem.id);
    expect(await sessionScopedMemoryIds(db, appX, sid, {})).toContain(mem.id);
    await db.session.update({ where: { id: sid }, data: { endedAt: new Date() } });
    expect(await sessionScopedMemoryIds(db, appX, sid, {})).toEqual([]);
  });
});

describe('#3401 controls: writes and the user path are unchanged', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`${cls}: the session key still cannot write the memory it now reads, and the refusal text is bare`, async () => {
      const mem = await sessionMemory({ cls });
      const auth = keyAuth(await session(mem.id));
      expect(await canReadMemory(db, auth, mem.id)).toBe(true);
      expect(await canWriteToMemory(db, auth, mem.id)).toBe(false);
      expect(await explainWriteRefusal(db, auth, mem.id)).toBe('');
      await createTestableMcpServer(auth).callToolText('hadron_create_node', {
        urn: `hrn:node:${mem.urn}:written`, name: 'written', content: 'x',
      });
      expect(await db.node.findFirst({ where: { memoryId: mem.id, loc: 'written' } })).toBeNull();
    });
  }

  it('a platform ADMIN user still cannot read another person\'s personal memory', async () => {
    const mem = await sessionMemory({ cls: 'personal' });
    const admin = (await db.user.create({ data: { id: generateId(), githubId: 3_401_001, githubUsername: `adm-${generateId().slice(-6)}`, roles: ['ADMIN'] } })).id;
    const auth = { userId: admin, roles: ['ADMIN'] } as AuthContext;
    expect(await canReadMemory(db, auth, mem.id)).toBe(false);
    expect((await getAccessibleMemoryIds({ db, ...auth } as unknown as Context)).includes(mem.id)).toBe(false);
  });

  it('the owner reads her own session memory directly through the App', async () => {
    const mem = await sessionMemory({ cls: 'personal' });
    expect(await canReadMemory(db, { userId: mia, appId: appX, roles: [] } as AuthContext, mem.id)).toBe(true);
  });
});
