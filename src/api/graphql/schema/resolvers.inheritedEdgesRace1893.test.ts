/**
 * Diego's P2 on #1899: `resolveInheritedEdges` selects an endpoint by loc
 * through the child, and reads the row it serves in a separate query, so a
 * concurrent write can land in between, in either order. These pins stage
 * that deterministically through a wrapped `db`: a hook runs right before the
 * selected endpoint is hydrated, or right after the edge query preloaded its
 * endpoints, and changes the endpoint the way a concurrent writer would.
 *
 * Chain: lead (C) extends backend (B) extends engineer (A). The reader is a
 * participant of an App installing only `lead`, and reads A's process through
 * C. B overrides A's `tasks:open-pr`, so through C that endpoint is B's node,
 * inherited. Whatever the interleaving, the reader is served only a version
 * that is in effect for C as read: never B's override after it turned boot
 * prompt, moved loc or memory, and never a row preloaded as a boot prompt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { markBatchReadNodes } from './resolvers.nodeBatchEdges.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const N = (resolvers as any).Node;
const E = (resolvers as any).Edge;

const hooks: { beforeHydrate?: { id: string; run: () => Promise<void> }; afterEdges?: () => Promise<void> } = {};

/** `db`, with one-shot hooks around the edge query and the endpoint hydration. */
const racyDb = new Proxy(db, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (prop === 'node') {
      return new Proxy(value, {
        get(t, p) {
          const fn = Reflect.get(t, p);
          if (p !== 'findUnique') return typeof fn === 'function' ? fn.bind(t) : fn;
          return async (args: { where: { id?: string } }) => {
            const hook = hooks.beforeHydrate;
            if (hook && args?.where?.id === hook.id) {
              hooks.beforeHydrate = undefined;
              await hook.run();
            }
            return fn.call(t, args);
          };
        },
      });
    }
    if (prop === 'edge') {
      return new Proxy(value, {
        get(t, p) {
          const fn = Reflect.get(t, p);
          if (p !== 'findMany') return typeof fn === 'function' ? fn.bind(t) : fn;
          return async (args: unknown) => {
            const out = await fn.call(t, args);
            const hook = hooks.afterEdges;
            hooks.afterEdges = undefined;
            if (hook) await hook();
            return out;
          };
        },
      });
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as typeof db;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let engineer: { id: string; mem: string };
let backend: { id: string; mem: string };
let lead: { id: string; mem: string };
let elsewhere: string;
const ids: Record<string, string> = {};

const racyCtx = (): Context => ({ db: racyDb, userId: reader, roles: ['READER'] });

async function agent(slug: string, baseId?: string) {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: slug, urn: `${org.urn}:${slug}-system` } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: baseId ?? null } });
  return { id: a.id, mem: mem.id };
}

async function node(key: string, memoryId: string, loc: string, role?: string) {
  ids[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: `${key} body`, role: role ?? null } })).id;
}

async function edge(from: string, to: string, name: string) {
  await db.edge.create({ data: { memoryId: engineer.mem, sourceId: ids[from]!, targetId: ids[to]!, name, loc: `e:${from}:${to}` } });
}

/** A's process, read through C, as GraphQL serves it (no hooks armed yet). */
const releaseThroughLead = () => Q.node({}, { ref: 'processes:release', memoryRef: lead.mem }, { db, userId: reader, roles: ['READER'] });

const outgoing = async () => {
  const release = await releaseThroughLead();
  const c = racyCtx();
  return Promise.all((await N.outgoingEdges(release, {}, c)).map(async (e: any) => ({ name: e.name, node: await E.target(e, {}, c) })));
};
const incoming = async () => {
  const release = await releaseThroughLead();
  const c = racyCtx();
  return Promise.all((await N.incomingEdges(release, {}, c)).map(async (e: any) => ({ name: e.name, node: await E.source(e, {}, c) })));
};
const byName = (got: Array<{ name: string; node: any }>) => new Map(got.map((g) => [g.name, g.node]));
const servedIds = (got: Array<{ name: string; node: any }>) => got.map((g) => g.node?.id);

const turnOverrideIntoBootPrompt = async () => {
  await db.node.update({ where: { id: ids.backOpenPr }, data: { role: 'boot-prompt', content: 'TURNED body' } });
};

beforeEach(async () => {
  await cleanDb(db);
  hooks.beforeHydrate = undefined;
  hooks.afterEdges = undefined;
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'EdgeRace', urn: `edge-race-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `edge-race-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer.id);
  lead = await agent('lead-engineer', backend.id);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: lead.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });
  elsewhere = (await db.memory.create({ data: { class: 'knowledge', organizationId: org.id, name: 'Elsewhere', urn: `${org.urn}:elsewhere` } })).id;

  await node('release', engineer.mem, 'processes:release', 'process.release');
  await node('engOpenPr', engineer.mem, 'tasks:open-pr');
  await node('ship', engineer.mem, 'tasks:ship');
  await node('draft', engineer.mem, 'tasks:draft', 'boot-prompt');
  await node('backOpenPr', backend.mem, 'tasks:open-pr');

  await edge('release', 'engOpenPr', 'stage 1'); // through C: B's override, inherited
  await edge('release', 'ship', 'stage 2'); // A's own, inherited
  await edge('release', 'draft', 'drafts'); // a base boot prompt: not in effect
  await edge('engOpenPr', 'release', 'part of'); // incoming, from the overridden endpoint
});

describe('controls: nothing changes in between', () => {
  it('both directions serve B\'s override (stamped) and A\'s inherited node; the boot prompt never', async () => {
    const out = byName(await outgoing());
    expect([...out.keys()].sort()).toEqual(['stage 1', 'stage 2']);
    expect(out.get('stage 1').id).toBe(ids.backOpenPr);
    expect(N.inheritedFrom(out.get('stage 1'))?.agentId).toBe(backend.id);
    expect(out.get('stage 2').id).toBe(ids.ship);
    const inc = byName(await incoming());
    expect(inc.get('part of')?.id).toBe(ids.backOpenPr);
  });

  it('a content-only edit of the override before hydration is served: still in effect, as read', async () => {
    hooks.beforeHydrate = { id: ids.backOpenPr!, run: async () => { await db.node.update({ where: { id: ids.backOpenPr }, data: { content: 'EDITED body' } }); } };
    const out = byName(await outgoing());
    expect(out.get('stage 1').id).toBe(ids.backOpenPr);
    expect(out.get('stage 1').content).toBe('EDITED body');
  });
});

describe('selection, then a write, then hydration (Diego\'s interleaving)', () => {
  it('outgoing: B\'s override turned boot prompt is never served under the old stamp', async () => {
    hooks.beforeHydrate = { id: ids.backOpenPr!, run: turnOverrideIntoBootPrompt };
    const got = await outgoing();
    expect(servedIds(got)).not.toContain(ids.backOpenPr);
    expect(got.map((g) => g.node?.content)).not.toContain('TURNED body');
    expect(servedIds(got)).not.toContain(ids.engOpenPr);
    expect(byName(got).get('stage 2')?.id).toBe(ids.ship);
  });

  it('incoming: the same', async () => {
    hooks.beforeHydrate = { id: ids.backOpenPr!, run: turnOverrideIntoBootPrompt };
    const got = await incoming();
    expect(servedIds(got)).not.toContain(ids.backOpenPr);
    expect(got.map((g) => g.node?.content)).not.toContain('TURNED body');
    expect(servedIds(got)).not.toContain(ids.engOpenPr);
  });

  it('a loc move of the override in between drops the edge, both directions', async () => {
    for (const read of [outgoing, incoming]) {
      await db.node.update({ where: { id: ids.backOpenPr }, data: { loc: 'tasks:open-pr' } });
      hooks.beforeHydrate = { id: ids.backOpenPr!, run: async () => { await db.node.update({ where: { id: ids.backOpenPr }, data: { loc: 'tasks:moved' } }); } };
      const got = await read();
      expect(servedIds(got)).not.toContain(ids.backOpenPr);
    }
  });

  it('a memory move of the override in between drops the edge, both directions', async () => {
    for (const read of [outgoing, incoming]) {
      await db.node.update({ where: { id: ids.backOpenPr }, data: { memoryId: backend.mem } });
      hooks.beforeHydrate = { id: ids.backOpenPr!, run: async () => { await db.node.update({ where: { id: ids.backOpenPr }, data: { memoryId: elsewhere } }); } };
      const got = await read();
      expect(servedIds(got)).not.toContain(ids.backOpenPr);
    }
  });
});

describe('the edge query preloads an endpoint, then a write, then the selection', () => {
  it('outgoing: an endpoint preloaded as a boot prompt is not served, even once it stops being one', async () => {
    hooks.afterEdges = async () => { await db.node.update({ where: { id: ids.draft }, data: { role: null } }); };
    const got = await outgoing();
    expect(servedIds(got)).not.toContain(ids.draft);
    expect(got.map((g) => g.node?.content)).not.toContain('draft body');
  });

  it('incoming: the same', async () => {
    await db.edge.create({ data: { memoryId: engineer.mem, sourceId: ids.draft!, targetId: ids.release!, name: 'drafted', loc: 'e:draft:release' } });
    hooks.afterEdges = async () => { await db.node.update({ where: { id: ids.draft }, data: { role: null } }); };
    const got = await incoming();
    expect(servedIds(got)).not.toContain(ids.draft);
  });
});


it.each(['role', 'loc', 'memory'] as const)('bounded metadata rejects an effective endpoint changed before hydration: %s', async (change) => {
  const parent = await releaseThroughLead();
  markBatchReadNodes([parent]);
  hooks.beforeHydrate = { id: ids.backOpenPr!, run: async () => {
    await db.node.update({ where: { id: ids.backOpenPr }, data: change === 'role'
      ? { role: 'boot-prompt' } : change === 'loc' ? { loc: 'tasks:moved' } : { memoryId: elsewhere } });
  } };
  const edges = await N.outgoingEdges(parent, {}, racyCtx());
  expect(edges.map((e: any) => e.name)).toEqual(['stage 2']);
});

it('a bounded lazy endpoint rechecks inheritance after metadata admission', async () => {
  const parent = await releaseThroughLead();
  markBatchReadNodes([parent]);
  const context = racyCtx();
  const edges = await N.outgoingEdges(parent, {}, context);
  const first = edges.find((e: any) => e.name === 'stage 1');
  expect(first).toBeDefined();
  await turnOverrideIntoBootPrompt();
  expect(await E.target(first, {}, context)).toBeNull();
});
