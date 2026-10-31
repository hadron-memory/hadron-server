/**
 * #2803 — direct `createEdge` onto an occupied edge loc must answer the typed
 * `EDGE_LOC_CONFLICT` the inline-edge path already uses (#1469/#1471), not let
 * the `(loc, memory_id)` unique violation escape as INTERNAL_SERVER_ERROR.
 *
 * Acceptance (gate: Xan's CHECKED comment):
 *  1. a second identical A -> B `routes-to` is refused EDGE_LOC_CONFLICT and
 *     exactly one edge exists;
 *  2. a caller who cannot read the memory gets what an unreadable memory gets
 *     today (NODE_NOT_FOUND), never a loc-occupied answer (no loc oracle);
 *  3. MCP `hadron_create_edge` (addEdge) keeps its contract on the duplicate;
 *  4. a different loc still succeeds (control).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { addEdge } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

let memoryId: string;
let memoryUrn: string;
let ownerId: string;
let aId: string;
let bId: string;

const ownerCtx = async (): Promise<Context> => {
  const u = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
  return { db, roles: u.roles as Context['roles'], userId: ownerId, clientId: `user:${ownerId}` };
};

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return ((e as { extensions?: { code?: string } }).extensions?.code) ?? `UNCODED:${(e as Error).message}`;
  }
};

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'o2803', urn: `o2803-${t}` } });
  const owner = await db.user.create({ data: { id: generateId(), githubId: 28030, githubUsername: `o2803-${t}` } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'OWNER' } });
  const mem = await M.createMemory({}, { orgId: org.id, name: `m2803-${t}` }, await ownerCtx());
  memoryId = mem.id;
  memoryUrn = mem.urn;
  const c = await ownerCtx();
  aId = (await M.createNode({}, { input: { memoryId, loc: 'n:a', name: 'a' } }, c)).id;
  bId = (await M.createNode({}, { input: { memoryId, loc: 'n:b', name: 'b' } }, c)).id;
});

describe('#2803 createEdge onto an occupied loc', () => {
  it('1. the second identical create is EDGE_LOC_CONFLICT and exactly one edge exists', async () => {
    const c = await ownerCtx();
    await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    const code = await codeOf(M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c));
    expect(code).toBe('EDGE_LOC_CONFLICT');
    expect(await db.edge.count({ where: { sourceId: aId } })).toBe(1);
  });

  it('1b. the message names the loc', async () => {
    const c = await ownerCtx();
    const first = await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    let message = '';
    try {
      await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(first.loc);
  });

  it('1c. an explicit occupied loc with different endpoints is also refused', async () => {
    const c = await ownerCtx();
    const cId = (await M.createNode({}, { input: { memoryId, loc: 'n:c', name: 'c' } }, c)).id;
    const first = await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'rel' }, c);
    const code = await codeOf(M.createEdge({}, { sourceRef: aId, targetRef: cId, name: 'rel', loc: first.loc }, c));
    expect(code).toBe('EDGE_LOC_CONFLICT');
    expect(await db.edge.count({ where: { memoryId } })).toBe(1);
  });

  it('2. a caller who cannot read the memory gets NODE_NOT_FOUND, not a loc answer (no oracle)', async () => {
    const c = await ownerCtx();
    await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    const t = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
    const stranger = await db.user.create({ data: { id: generateId(), githubId: 28031, githubUsername: `st2803-${t}` } });
    const who = { db, roles: ['READER'], userId: stranger.id, clientId: `user:${stranger.id}` } as Context;
    const dup = await codeOf(M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, who));
    const fresh = await codeOf(M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'other' }, who));
    expect(dup).toBe('NODE_NOT_FOUND');
    expect(dup).toBe(fresh);
  });

  it('3. MCP hadron_create_edge: a duplicate loc with a different payload is [edge_loc_conflict]', async () => {
    const c = await ownerCtx();
    const first = await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    const auth = { userId: ownerId, roles: ['READER'], clientId: `user:${ownerId}` } as never;
    const result = await addEdge({
      sourceUrn: `${memoryUrn}:n:a`.replace(/^hrn:mem:/, 'hrn:node:'),
      targetUrn: `${memoryUrn}:n:b`.replace(/^hrn:mem:/, 'hrn:node:'),
      name: 'routes-to', loc: first.loc, description: 'different', auth,
    });
    expect(JSON.stringify(result)).toContain('[edge_loc_conflict]');
  });

  it('4. a different loc still succeeds (control)', async () => {
    const c = await ownerCtx();
    await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to' }, c);
    const second = await M.createEdge({}, { sourceRef: aId, targetRef: bId, name: 'routes-to', loc: 'edge:other' }, c);
    expect(second.loc).toBe('edge:other');
    expect(await db.edge.count({ where: { sourceId: aId } })).toBe(2);
  });
});
