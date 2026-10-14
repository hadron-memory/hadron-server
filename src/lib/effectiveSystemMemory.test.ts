/**
 * #1885 slice 2 — the effective system memory set (cor:dmo:050:14), computed
 * at the database: the chain, nearest-wins by loc, boot prompts never passed
 * down, read live. The read surfaces and their gate are pinned separately.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { descendantMemoriesInheriting, inheritedNodeIds, systemMemoryChain } from './effectiveSystemMemory.js';

let n: number;
let org: { id: string; urn: string };

type Ag = { id: string; urn: string; mem: string };

async function agent(slug: string, base?: Ag): Promise<Ag> {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: `${org.urn}:${slug}-system` } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, urn: a.urn, mem: mem.id };
}

async function node(a: Ag, loc: string, data: { role?: string; deleted?: boolean } = {}): Promise<string> {
  const row = await db.node.create({
    data: { memoryId: a.mem, loc, name: loc, content: `${a.urn} ${loc}`, role: data.role ?? null, deletedAt: data.deleted ? new Date() : null },
  });
  return row.id;
}

const inherited = async (a: Ag) => {
  const map = await inheritedNodeIds(db, await systemMemoryChain(db, a.mem));
  return new Map([...map].map(([id, link]) => [id, link.agentId]));
};

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Eff', urn: `eff-${n}.example` }, select: { id: true, urn: true } });
});

describe('the chain', () => {
  it('is the memory\'s own Agent, then its bases, nearest first', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const go = await agent('go-engineer', backend);
    const chain = await systemMemoryChain(db, go.mem);
    expect(chain.map((l) => l.agentId)).toEqual([go.id, backend.id, engineer.id]);
    expect(chain.map((l) => l.memoryId)).toEqual([go.mem, backend.mem, engineer.mem]);
  });

  it('is just the memory itself for an Agent that extends nothing, and empty for a memory no Agent owns', async () => {
    const engineer = await agent('engineer');
    expect((await systemMemoryChain(db, engineer.mem)).map((l) => l.agentId)).toEqual([engineer.id]);
    const loose = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'loose', urn: `${org.urn}:loose` } });
    expect(await systemMemoryChain(db, loose.id)).toEqual([]);
  });
});

describe('S1 — a child\'s own node replaces the base\'s at the same loc; the rest comes through', () => {
  it('backend-engineer inherits engineer\'s release process, never engineer\'s tasks:open-pr', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const baseTask = await node(engineer, 'tasks:open-pr');
    const release = await node(engineer, 'processes:release', { role: 'process.release' });
    await node(backend, 'tasks:open-pr');
    const got = await inherited(backend);
    expect(got.get(release)).toBe(engineer.id);
    expect(got.has(baseTask)).toBe(false);
    expect(await descendantMemoriesInheriting(db, { id: release, memoryId: engineer.mem, loc: 'processes:release', role: 'process.release' })).toEqual([backend.mem]);
    expect(await descendantMemoriesInheriting(db, { id: baseTask, memoryId: engineer.mem, loc: 'tasks:open-pr', role: null })).toEqual([]);
  });
});

describe('S2 — read live', () => {
  it('a base\'s new node, or a child deleting its override, shows on the next read', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const baseTask = await node(engineer, 'tasks:open-pr');
    const own = await node(backend, 'tasks:open-pr');
    expect((await inherited(backend)).has(baseTask)).toBe(false);
    await db.node.update({ where: { id: own }, data: { deletedAt: new Date() } });
    expect((await inherited(backend)).get(baseTask)).toBe(engineer.id);
    const later = await node(engineer, 'tasks:later');
    expect((await inherited(backend)).get(later)).toBe(engineer.id);
  });
});

describe('S3 — the nearest Agent wins', () => {
  it('go-engineer gets backend-engineer\'s tasks:review, not engineer\'s', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const go = await agent('go-engineer', backend);
    const far = await node(engineer, 'tasks:review');
    const near = await node(backend, 'tasks:review');
    const got = await inherited(go);
    expect(got.get(near)).toBe(backend.id);
    expect(got.has(far)).toBe(false);
    // Through the middle Agent, the far one is overridden by its own node.
    expect(await descendantMemoriesInheriting(db, { id: far, memoryId: engineer.mem, loc: 'tasks:review', role: null })).toEqual([]);
    expect(await descendantMemoriesInheriting(db, { id: near, memoryId: backend.mem, loc: 'tasks:review', role: null })).toEqual([go.mem]);
  });
});

describe('boot prompts are never inherited (ruling 2)', () => {
  it('a base\'s boot prompt is not passed down and hides nothing; a child\'s own boot prompt is its own', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const go = await agent('go-engineer', backend);
    const farPrompt = await node(engineer, 'prompts:boot', { role: 'boot-prompt' });
    const midPrompt = await node(backend, 'prompts:boot', { role: 'boot-prompt.compiled' });
    const farOther = await node(engineer, 'notes:x');
    await node(backend, 'notes:x', { role: 'boot-prompt' });
    const got = await inherited(go);
    expect(got.has(farPrompt)).toBe(false);
    expect(got.has(midPrompt)).toBe(false);
    // backend's boot-prompt node at notes:x isn't a candidate, so engineer's notes:x comes through.
    expect(got.get(farOther)).toBe(engineer.id);
    expect(await descendantMemoriesInheriting(db, { id: farPrompt, memoryId: engineer.mem, loc: 'prompts:boot', role: 'boot-prompt' })).toEqual([]);
    expect((await descendantMemoriesInheriting(db, { id: farOther, memoryId: engineer.mem, loc: 'notes:x', role: null })).sort()).toEqual([go.mem]);
  });

  it('a child\'s own node at a base boot prompt\'s loc is simply the child\'s', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    await node(engineer, 'prompts:boot', { role: 'boot-prompt' });
    await node(backend, 'prompts:boot', { role: 'boot-prompt' });
    expect((await inherited(backend)).size).toBe(0);
  });
});

describe('what never comes through', () => {
  it('deleted base nodes, a retired base, and a cleared base', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const gone = await node(engineer, 'tasks:gone', { deleted: true });
    const live = await node(engineer, 'tasks:live');
    expect((await inherited(backend)).has(gone)).toBe(false);
    expect((await inherited(backend)).has(live)).toBe(true);
    await db.agent.update({ where: { id: backend.id }, data: { extendsAgentId: null } });
    expect((await inherited(backend)).size).toBe(0);
    expect(await descendantMemoriesInheriting(db, { id: live, memoryId: engineer.mem, loc: 'tasks:live', role: null })).toEqual([]);
  });

  it('a retired child inherits nothing and is no audience', async () => {
    const engineer = await agent('engineer');
    const backend = await agent('backend-engineer', engineer);
    const live = await node(engineer, 'tasks:live');
    await db.agent.update({ where: { id: backend.id }, data: { deletedAt: new Date() } });
    expect(await systemMemoryChain(db, backend.mem)).toEqual([]);
    expect(await descendantMemoriesInheriting(db, { id: live, memoryId: engineer.mem, loc: 'tasks:live', role: null })).toEqual([]);
  });
});
