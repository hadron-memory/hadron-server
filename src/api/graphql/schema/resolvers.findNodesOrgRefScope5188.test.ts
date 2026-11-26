/**
 * #5188 — pin findNodes' NON-global scope-lens org narrowing (Rook's optional
 * P3 on #5166, left unpinned by the rename): a named scope holding memories of
 * TWO organizations, plus `orgRef`, returns only that organization's memories.
 * The lens narrows to its memories ∩ access (spec 049 S2) and the org argument
 * narrows WITHIN that (`cor:api:100:01` AND-narrowing — a lens never widens,
 * and the org filter never widens it either). The scope envelope still
 * materialises both memories: the narrowing shows in the hits, not the lens.
 *
 * Mutant (the #5188 seat runs this): drop `orgRef` from the inner `core` call
 * for a NON-GLOBAL scope — resolvers.query.node.ts, `let innerOrgId =
 * coreArgs.orgRef;` → `let innerOrgId: string | null = null;` (leave the
 * `scopeRes.kind === 'global'` line alone). Both organizations' nodes come
 * back and this pin goes red. Do NOT mutate by deleting the `orgRef:
 * innerOrgId` key from the `core({ ... })` call: `...coreArgs` spreads the
 * caller's `orgRef` back in, so that edit changes nothing and no test can
 * kill it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let lensAuthor: { id: string };
let memA: { id: string; urn: string };
let memB: { id: string; urn: string };

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;
const locsOf = (r: any) => r.hits.map((h: any) => `${h.node.memoryId}:${h.node.loc}`).sort();

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'oa', urn: `oa-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'ob', urn: `ob-${t}` } });
  // CONTRIBUTOR in the scope's owner org (orgA) and READER in orgB: the only
  // shape that can AUTHOR a cross-org lens — resolveScopeMemoryRefs demands
  // every memory be in the author's accessible set — and still read both sides.
  lensAuthor = await db.user.create({ data: { id: generateId(), githubId: 51881, githubUsername: `la-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: lensAuthor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: lensAuthor.id, role: 'READER' } });
  const mem = (org: { id: string; urn: string }, slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  memA = await mem(orgA, 'a');
  memB = await mem(orgB, 'b');
  for (const m of [memA, memB]) {
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'alpha', name: 'alpha', nodeType: 'info', content: 'alpha content' } });
  }
});

describe('#5188 — findNodes: a non-global scope lens narrows by orgRef', () => {
  it('a named scope holding two organizations\' memories returns only the orgRef org\'s nodes', async () => {
    const s = await M.createScope({}, { input: { name: 'cross-org-lens', organizationRef: orgA.urn, memoryRefs: [memA.urn, memB.urn] } }, ctx(lensAuthor.id));
    // The lens itself holds BOTH memories (the caller reads both; nothing is
    // dropped by access) — the envelope materialises them, so what follows
    // narrows inside the lens rather than shrinking the lens.
    const unscoped = await Q.findNodes({}, { scope: s.id }, ctx(lensAuthor.id));
    expect(locsOf(unscoped)).toEqual([`${memA.id}:alpha`, `${memB.id}:alpha`].sort());
    expect(new Set(unscoped.scope.memoryUrns)).toEqual(new Set([memA.urn, memB.urn]));
    expect(unscoped.scope.droppedCount).toBe(0);

    // orgRef narrows WITHIN the lens: only that organization's nodes, in both
    // directions, so the narrowing demonstrably follows the org argument and
    // is not an artifact of memory or creation order.
    const inA = await Q.findNodes({}, { scope: s.id, orgRef: orgA.urn }, ctx(lensAuthor.id));
    expect(locsOf(inA)).toEqual([`${memA.id}:alpha`]);
    const inB = await Q.findNodes({}, { scope: s.id, orgRef: orgB.urn }, ctx(lensAuthor.id));
    expect(locsOf(inB)).toEqual([`${memB.id}:alpha`]);
  });
});
