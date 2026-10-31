/**
 * #2967 — edge order is a product order, not physical row order. The same edges inserted in two
 * physical orders must read byte-identically through the MCP node reads (display: loc, id) and
 * resolve identically for a run (priority, loc, id; cor:dmo:060:03).
 */

import { it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

let adminId: string;
let memoryId: string;
let ids: { s: string; targets: Record<string, string>; sources: Record<string, string> };

const auth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const LETTERS = ['a', 'b', 'c', 'd', 'e'] as const;
// Edge priority per letter: priority order (e, b, d, c, a) disagrees with loc order (a..e).
const PRIORITY: Record<string, number> = { a: 3, b: 1, c: 2, d: 1, e: 0 };
const PRIORITY_ORDER = ['e', 'b', 'd', 'c', 'a'];
const MEM = 'hrn:mem:edge-org:edgemem';
const urnOf = (loc: string) => `hrn:node:edge-org:edgemem:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'edge-org', urn: 'edge-org' } });
  const admin = await db.user.create({ data: { githubId: 9967, githubUsername: 'edge-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;
  const memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'edgemem' }, { db, roles: ['ADMIN'], userId: admin.id } as Context);
  memoryId = memory.id;
  const mk = (loc: string, extra: Record<string, unknown> = {}) =>
    db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `CONTENT-${loc}`, ...extra } });
  await mk('ord');
  const s = await mk('ord:s', { seq: 1, content: 'Run body.' });
  const targets: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const l of LETTERS) { targets[l] = (await mk(`ord:t:${l}`)).id; sources[l] = (await mk(`ord:i:${l}`)).id; }
  ids = { s: s.id, targets, sources };
});

/** Insert the five out and five in edges, in `order`, after clearing any earlier insert. */
async function seedEdges(order: 'sorted' | 'reversed') {
  await db.edge.deleteMany({ where: { memoryId } });
  // Scrambled so neither the loc order nor the priority order equals this array order.
  const rows = LETTERS.flatMap((l) => [
    { id: generateId(), memoryId, sourceId: ids.s, targetId: ids.targets[l], loc: `ord:s:out:${l}`, name: 'ref', priority: PRIORITY[l] },
    { id: generateId(), memoryId, sourceId: ids.sources[l], targetId: ids.s, loc: `ord:s:in:${l}`, name: 'ref', priority: PRIORITY[l] },
  ]);
  const byLoc = [...rows].sort((x, y) => (x.loc < y.loc ? -1 : 1));
  await db.edge.createMany({ data: order === 'sorted' ? byLoc : byLoc.reverse() });
}

const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('  - hrn:node:'));
const endpointOrder = (text: string, side: 'out' | 'in') =>
  lines(text).filter((l) => l.includes(side === 'out' ? ':ord:t:' : ':ord:i:')).map((l) => l.match(/:ord:[ti]:(\w)/)![1]);
const referencedOrder = (text: string) => [...text.matchAll(/CONTENT-ord:t:(\w)/g)].map((m) => m[1]);

it.each(['sorted', 'reversed'] as const)('hadron_get_node / hadron_get_nodes list edges by loc then id (inserted %s)', async (order) => {
  await seedEdges(order);
  const server = createTestableMcpServer(auth());
  const single = await server.callToolText('hadron_get_node', { urn: urnOf('ord:s'), contentScope: 'abstract' });
  const batch = await server.callToolText('hadron_get_nodes', { refs: [ids.s], contentScope: 'abstract' });
  for (const text of [single, batch]) {
    expect(endpointOrder(text, 'out')).toEqual([...LETTERS]);
    expect(endpointOrder(text, 'in')).toEqual([...LETTERS]);
  }
});

it.each(['sorted', 'reversed'] as const)('hadron_get_next_node lists edges by loc then id (inserted %s)', async (order) => {
  await seedEdges(order);
  const text = await createTestableMcpServer(auth()).callToolText('hadron_get_next_node', { parent: urnOf('ord') });
  expect(text).toContain('Run body.');
  // The next-node projection renders only the outgoing "Related:" lines.
  expect(endpointOrder(text, 'out')).toEqual([...LETTERS]);
});

it('hadron_get_nodes output is byte-identical across the two physical insert orders', async () => {
  const server = createTestableMcpServer(auth());
  await seedEdges('sorted');
  const a = await server.callToolText('hadron_get_nodes', { refs: [ids.s], contentScope: 'all', raw: true });
  await seedEdges('reversed');
  const b = await server.callToolText('hadron_get_nodes', { refs: [ids.s], contentScope: 'all', raw: true });
  // Edge ids are fresh per seed, so compare with them masked; every other byte must match.
  const mask = (t: string) => t.replace(/[0-9a-f]{32}/g, '<id>');
  expect(mask(b)).toBe(mask(a));
});

it.each(['sorted', 'reversed'] as const)('hadron_run_action resolves referenced nodes by priority, loc, id (inserted %s)', async (order) => {
  await seedEdges(order);
  const text = await createTestableMcpServer(auth()).callToolText('hadron_run_action', { urn: urnOf('ord:s') });
  expect(referencedOrder(text)).toEqual(PRIORITY_ORDER);
});
