import { randomUUID } from 'node:crypto';
/**
 * #1885 slice 2, Diego's P2-1 on #1891: the effective set is computed BEFORE
 * the read that serves it, so a base can change in between. These pins stage
 * that interleaving deterministically: the module is wrapped so a hook runs
 * right after the scope snapshot (listings) or the loc selection (single
 * reads), and the hook changes the base the way a concurrent writer would.
 * Every surface must then serve only what is effective NOW, on the version it
 * actually read: a base boot prompt inserted after the snapshot, a node turned
 * boot prompt after selection, and a child override added after either never
 * come through; untouched inherited content still does.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

const hooks: { afterScope?: () => Promise<void>; afterLoc?: () => Promise<void> } = {};

vi.mock('../../../lib/effectiveSystemMemory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/effectiveSystemMemory.js')>();
  return {
    ...mod,
    effectiveScope: async (...args: Parameters<typeof mod.effectiveScope>) => {
      const out = await mod.effectiveScope(...args);
      const hook = hooks.afterScope;
      hooks.afterScope = undefined;
      if (hook) await hook();
      return out;
    },
    findEffectiveNodeIdByLoc: async (...args: Parameters<typeof mod.findEffectiveNodeIdByLoc>) => {
      const out = await mod.findEffectiveNodeIdByLoc(...args);
      const hook = hooks.afterLoc;
      hooks.afterLoc = undefined;
      if (hook) await hook();
      return out;
    },
  };
});
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let engineer: { mem: string; memUrn: string };
let backend: { mem: string; memUrn: string };
const ids: Record<string, string> = {};
const ctx = (): Context => ({ db, userId: reader, roles: ['READER'] });
const mcp = (tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId: reader, roles: ['READER'], clientId: `user:${reader}` }).callToolText(tool, params);

async function agent(slug: string, baseId?: string) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: slug, urn: memUrn } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: baseId ?? null } });
  return { id: a.id, mem: mem.id, memUrn };
}

const insertBootPrompt = async () => {
  ids.lateBoot = (await db.node.create({ data: { memoryId: engineer.mem, loc: 'tasks:late-boot', name: 'LateBoot', content: 'LateBoot body', role: 'boot-prompt' } })).id;
};
const turnReleaseIntoBootPrompt = async () => {
  await db.node.update({ where: { id: ids.engRelease }, data: { role: 'boot-prompt', content: 'TURNED body' } });
};
const overrideShip = async () => {
  await db.node.create({ data: { memoryId: backend.mem, loc: 'tasks:ship', name: 'BackShip', content: 'BackShip body' } });
};

beforeEach(async () => {
  await cleanDb(db);
  hooks.afterScope = undefined;
  hooks.afterLoc = undefined;
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Race', urn: `race-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `race-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  const eng = await agent('engineer');
  const back = await agent('backend-engineer', eng.id);
  engineer = eng;
  backend = back;
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: back.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });
  ids.engRelease = (await db.node.create({ data: { memoryId: eng.mem, loc: 'tasks:release', name: 'EngRelease', content: 'EngRelease body' } })).id;
  ids.engShip = (await db.node.create({ data: { memoryId: eng.mem, loc: 'tasks:ship', name: 'EngShip', content: 'EngShip body' } })).id;
  ids.engKeep = (await db.node.create({ data: { memoryId: eng.mem, loc: 'tasks:keep', name: 'EngKeep', content: 'EngKeep body' } })).id;
});

describe('listings re-check what they read against the effective set now', () => {
  const graphIds = async (args: Record<string, unknown>) =>
    (await Q.findNodes({}, { filter: { memoryIds: [backend.mem] }, ...args }, ctx())).hits.map((h: any) => h.node.id);

  it('GraphQL findNodes: a boot prompt inserted, a node turned boot prompt, an override added after the snapshot', async () => {
    hooks.afterScope = async () => { await insertBootPrompt(); await turnReleaseIntoBootPrompt(); await overrideShip(); };
    const got = await graphIds({});
    expect(got).toContain(ids.engKeep);
    expect(got).not.toContain(ids.lateBoot);
    expect(got).not.toContain(ids.engRelease);
    expect(got).not.toContain(ids.engShip);
  });

  it('GraphQL findNodes keyword mode, the same', async () => {
    hooks.afterScope = async () => { await insertBootPrompt(); await turnReleaseIntoBootPrompt(); };
    const got = await graphIds({ query: 'LateBoot OR EngRelease OR EngKeep' });
    expect(got).toEqual([ids.engKeep]);
  });

  it('GraphQL nodeBatch prefix, the same', async () => {
    hooks.afterScope = async () => { await insertBootPrompt(); await overrideShip(); };
    const r = await Q.nodeBatch(null, { memory: backend.mem, locPrefix: 'tasks:' }, ctx());
    const got = r.nodes.map((x: any) => x.id);
    expect(got).toContain(ids.engKeep);
    expect(got).not.toContain(ids.lateBoot);
    expect(got).not.toContain(ids.engShip);
  });

  it('GraphQL appNodes, the same', async () => {
    const app = await db.app.findFirstOrThrow({ where: { organizationId: org.id } });
    hooks.afterScope = async () => { await insertBootPrompt(); await overrideShip(); };
    const got = (await Q.appNodes({}, { appRef: app.id }, ctx())).map((r: any) => r.id);
    expect(got).toContain(ids.engKeep);
    expect(got).not.toContain(ids.lateBoot);
    expect(got).not.toContain(ids.engShip);
  });

  it('MCP hadron_list_nodes and hadron_get_nodes prefix, the same', async () => {
    hooks.afterScope = async () => { await insertBootPrompt(); await turnReleaseIntoBootPrompt(); };
    const listed = await mcp('hadron_list_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, depth: 3 });
    expect(listed).toContain('EngKeep');
    expect(listed).not.toContain('LateBoot');
    expect(listed).not.toContain('EngRelease');
    hooks.afterScope = async () => { await overrideShip(); };
    const batch = await mcp('hadron_get_nodes', { memoryUrn: `hrn:mem:${backend.memUrn}`, locPrefix: 'tasks:' });
    expect(batch).toContain('EngKeep body');
    expect(batch).not.toContain('EngShip body');
  });
});

describe('single reads re-check the version they serve against the child they came through', () => {
  it('GraphQL node(ref:, memoryRef:): a node turned boot prompt after selection is not served', async () => {
    hooks.afterLoc = turnReleaseIntoBootPrompt;
    expect(await Q.node({}, { ref: 'tasks:release', memoryRef: backend.mem }, ctx())).toBeNull();
    expect((await Q.node({}, { ref: 'tasks:keep', memoryRef: backend.mem }, ctx()))?.id).toBe(ids.engKeep);
  });

  it('GraphQL node(ref: child URN) and nodeBatch explicit: an override added after selection wins', async () => {
    hooks.afterLoc = overrideShip;
    expect(await Q.node({}, { ref: `hrn:node:${backend.memUrn}:tasks:ship` }, ctx())).toBeNull();
    await db.node.deleteMany({ where: { memoryId: backend.mem, loc: 'tasks:ship' } });
    hooks.afterLoc = overrideShip;
    const r = await Q.nodeBatch(null, { refs: [`hrn:node:${backend.memUrn}:tasks:ship`] }, ctx());
    expect(r.nodes).toEqual([]);
  });

  it('MCP hadron_get_node and hadron_get_nodes explicit: the same', async () => {
    hooks.afterLoc = turnReleaseIntoBootPrompt;
    expect(await mcp('hadron_get_node', { urn: `hrn:node:${backend.memUrn}:tasks:release` })).toMatch(/not found/);
    hooks.afterLoc = overrideShip;
    const out = await mcp('hadron_get_nodes', { refs: [`hrn:node:${backend.memUrn}:tasks:ship`] });
    expect(out).not.toContain('EngShip body');
    expect(out).not.toContain('TURNED body');
  });
});

describe('P2-1 in chunk mode (Diego, #1891 at 65d3ce85): passages re-check their parents', () => {
  // Every text embeds on one axis, so every indexed chunk is a candidate and
  // only the effective-set re-check can keep a passage out.
  const stub: EmbeddingClient = {
    provider: 'test', model: 'stub-model', dim: 768,
    async embed(texts: string[]) { return texts.map(() => { const v = new Array(768).fill(0); v[1] = 1; return v; }); },
  };
  const parentIds = async () => (await Q.findNodes({}, {
    query: 'q', mode: 'vector', granularity: 'chunk', filter: { memoryIds: [backend.mem] },
  }, ctx())).passages.map((p: any) => p.parentNodeId);

  beforeEach(async () => {
    process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
    setEmbeddingClientForTests(stub);
    await db.memory.updateMany({ where: { id: { in: [engineer.mem, backend.mem] } }, data: { vectorIndexEnabled: true, embeddingSource: 'contentChunks' } });
    for (const id of [ids.engRelease, ids.engShip, ids.engKeep]) {
      await db.node.update({ where: { id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
      expect(await embedNode(db, id)).toBe('embedded');
    }
  });
  afterAll(() => { resetEmbeddingClientForTests(); delete process.env.EMBEDDING_API_URL; });

  it('control: with nothing changed, every inherited parent\'s passage comes through', async () => {
    expect(new Set(await parentIds())).toEqual(new Set([ids.engRelease, ids.engShip, ids.engKeep]));
  });

  it('GraphQL findNodes: a node turned boot prompt and a node overridden after the snapshot serve no passage', async () => {
    hooks.afterScope = async () => { await turnReleaseIntoBootPrompt(); await overrideShip(); };
    const got = await parentIds();
    expect(got).toContain(ids.engKeep);
    expect(got).not.toContain(ids.engRelease);
    expect(got).not.toContain(ids.engShip);
  });

  it('MCP hadron_find_nodes granularity:chunk, the same', async () => {
    hooks.afterScope = async () => { await turnReleaseIntoBootPrompt(); await overrideShip(); };
    const out = await mcp('hadron_find_nodes', { query: 'q', mode: 'vector', granularity: 'chunk', memoryUrn: backend.memUrn });
    expect(out).toContain('EngKeep body');
    expect(out).not.toContain('EngRelease body');
    expect(out).not.toContain('EngShip body');
  });
});
