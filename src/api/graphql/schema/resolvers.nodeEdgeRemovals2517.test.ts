/**
 * #2517 — a hard delete cascades the Edge rows other nodes held to the deleted node, and until now
 * recorded nothing on those SOURCE nodes, so a source's history never showed an edge of its own had
 * vanished. Holger's ruling (2026-10-27, cor:dmo:010:04, Proposed): the removal is visible from each
 * source node as a SEPARATE audit entry — not a new NodeRevision. A soft delete keeps its edges and
 * records nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

let admin: { id: string };
let mem: { id: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'er-org', urn: 'er-org' } });
  admin = await db.user.create({ data: { githubId: 25170, githubUsername: 'er-admin', handle: 'er-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'er-org:m', name: 'm', class: 'knowledge' },
    select: { id: true },
  });
});

const node = (loc: string) =>
  db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: loc } });

const edge = (loc: string, sourceId: string, targetId: string, name = 'depends_on') =>
  db.edge.create({ data: { id: generateId(), memoryId: mem.id, loc, sourceId, targetId, name } });

const removals = (nodeRef: string) =>
  resolvers.Query.nodeEdgeRemovals({}, { nodeRef }, ctx()) as Promise<Array<Record<string, unknown>>>;

describe('#2517 — hard delete leaves a trace on the nodes that pointed at it', () => {
  it('records one entry on the source naming the removed edge, its target and the actor', async () => {
    const source = await node('src');
    const target = await node('tgt');
    const e = await edge('src:to-tgt', source.id, target.id);

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id, hard: true }, ctx());

    const entries = await removals(source.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      edgeLoc: e.loc,
      edgeName: 'depends_on',
      targetLoc: 'tgt',
      reason: 'TARGET_HARD_DELETED',
      removedBy: admin.id,
    });
    expect(await db.edge.count({ where: { id: e.id } })).toBe(0);
  });

  it('a soft delete keeps the edge and records nothing', async () => {
    const source = await node('src');
    const target = await node('tgt');
    await edge('src:to-tgt', source.id, target.id);

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id }, ctx());

    expect(await removals(source.id)).toEqual([]);
    expect(await db.edge.count({ where: { sourceId: source.id } })).toBe(1);
  });

  it('is an audit entry, not a revision: the source gains no NodeRevision', async () => {
    const source = await node('src');
    const target = await node('tgt');
    await edge('src:to-tgt', source.id, target.id);
    const before = await db.nodeRevision.count({ where: { nodeId: source.id } });

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id, hard: true }, ctx());

    expect(await db.nodeRevision.count({ where: { nodeId: source.id } })).toBe(before);
  });

  it('gives each of two sources its own entry, and a bystander none', async () => {
    const a = await node('a');
    const b = await node('b');
    const bystander = await node('c');
    const target = await node('tgt');
    await edge('a:to-tgt', a.id, target.id);
    await edge('b:to-tgt', b.id, target.id);
    await edge('c:to-a', bystander.id, a.id);

    await resolvers.Mutation.deleteNode({}, { nodeRef: target.id, hard: true }, ctx());

    expect(await removals(a.id)).toHaveLength(1);
    expect(await removals(b.id)).toHaveLength(1);
    expect(await removals(bystander.id)).toEqual([]);
  });

  it('records nothing for an edge whose source is deleted in the same operation', async () => {
    const parent = await node('p');
    const child = await node('p:child');
    await edge('p:child:to-p', child.id, parent.id);

    await resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, hard: true, recursive: true }, ctx());

    expect(await db.nodeEdgeRemoval.count()).toBe(0);
  });
});
