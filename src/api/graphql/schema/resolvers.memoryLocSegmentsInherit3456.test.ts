/**
 * #3456 — memoryLocSegments over an Agent's effective system memory (cor:api:090:05, cor:dmo:050:14):
 * a base's segments join the child's under the BASE's memory id; a base node the child overrides, and a base's
 * boot prompts, never make a segment; a reader who cannot read the base gets only what came through the child.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
let org: { id: string; urn: string };
let reader: string;
let engineer: { id: string; mem: string };
let backend: { id: string; mem: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
async function agent(slug: string, base?: { id: string }) {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: `${org.urn}:${slug}-system` } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, mem: mem.id };
}
const node = (memoryId: string, loc: string, role: string | null = null) =>
  db.node.create({ data: { memoryId, loc, name: loc, content: loc, role } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Seg', urn: `seg3456-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `seg-reader-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer);
  const appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  await db.appAgent.create({ data: { appId, agentId: backend.id } });
  await db.appMember.create({ data: { appId, userId: reader, role: 'member' } });
  await node(engineer.mem, 'processes:release');
  await node(engineer.mem, 'tasks:open-pr');
  await node(engineer.mem, 'prompts:boot', 'boot-prompt');
  await node(engineer.mem, 'basefolder:only');
  await node(backend.mem, 'tasks:open-pr');
  await node(backend.mem, 'notes:own');
});

describe('#3456 inheritance', () => {
  it('the base\'s segments appear under the base\'s memory id; the child\'s keep the child\'s', async () => {
    const page = await Q.memoryLocSegments({}, { memoryIds: [backend.mem], parentLoc: '', limit: 200 }, ctx(reader));
    const rows = page.items.map((i: any) => `${i.memoryId === backend.mem ? 'backend' : i.memoryId === engineer.mem ? 'engineer' : '?'}:${i.segment}:${i.hasNode}`).sort();
    // engineer's `tasks` branch is wholly overridden by the child's tasks:open-pr, so only the child lists `tasks`.
    expect(rows).toEqual(['backend:notes:false', 'backend:tasks:false', 'engineer:basefolder:false', 'engineer:processes:false']);
  });

  it('a base node the child overrides is not listed; the base\'s boot prompt makes no segment', async () => {
    const root = await Q.memoryLocSegments({}, { memoryIds: [backend.mem], parentLoc: 'tasks', limit: 200 }, ctx(reader));
    expect(root.items.map((i: any) => [i.segment, i.memoryId])).toEqual([['open-pr', backend.mem]]);
    const prompts = await Q.memoryLocSegments({}, { memoryIds: [backend.mem], parentLoc: 'prompts', limit: 200 }, ctx(reader));
    expect(prompts.items).toEqual([]);
  });

  it('a reader who cannot read the base asks for the base directly and gets the empty page', async () => {
    const page = await Q.memoryLocSegments({}, { memoryIds: [engineer.mem], parentLoc: '' }, ctx(reader));
    expect(page).toEqual({ items: [], hasMore: false, endCursor: null });
  });
});
