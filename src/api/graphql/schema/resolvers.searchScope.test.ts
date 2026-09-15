/**
 * Spec 049 Phase 3 — the search ladder on GraphQL (D-2026-09-13-002 / -004).
 *
 * On GraphQL only a scope NAMED IN THE CALL applies (no session state for a
 * user principal); omitted ⇒ pre-049 semantics, and the envelope's `scope` is
 * null — pinned first, because that is the promise to the portal and the CLI.
 * Then: a named scope narrows to its memories ∩ access and DISCLOSES the rest
 * as a count + `scope_narrowed`; `filter.memoryIds` narrows within it; `app`
 * is the App's attached memories; `global` is the org view and refuses with
 * ORG_REQUIRED when the org is ambiguous; an unreadable scope is NOT_FOUND;
 * globalSearch's node slice obeys the same scope.
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
let contributor: { id: string };
let reader: { id: string };
let twoOrgs: { id: string };
let app: { id: string; urn: string };
let memA1: { id: string; urn: string };
let memA2: { id: string; urn: string };
let memB: { id: string; urn: string };
let personal: { id: string; urn: string };

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;
const locsOf = (r: any) => r.hits.map((h: any) => `${h.node.memoryId}:${h.node.loc}`).sort();

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'ss-a', urn: `ss-a-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'ss-b', urn: `ss-b-${t}` } });
  contributor = await db.user.create({ data: { id: generateId(), githubId: 48301, githubUsername: `ss-c-${t}` } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 48302, githubUsername: `ss-r-${t}` } });
  twoOrgs = await db.user.create({ data: { id: generateId(), githubId: 48303, githubUsername: `ss-t-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: twoOrgs.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: twoOrgs.id, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'A app', urn: `${orgA.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'member' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'ag', urn: `${orgA.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const mem = (org: { id: string; urn: string }, slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  memA1 = await mem(orgA, 'a1');
  memA2 = await mem(orgA, 'a2');
  memB = await mem(orgB, 'b');
  await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: memA1.id, role: 'read' } });
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:c-personal`, name: 'p', class: 'personal', userId: contributor.id, appId: app.id, userMemoryOfAgentId: agent.id },
  });
  for (const m of [memA1, memA2, memB, personal]) {
    await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'alpha', name: 'alpha', nodeType: 'info', content: 'alpha content' } });
  }
});

describe('omitted scope — the pre-049 promise', () => {
  it('returns the accessible set with scope: null', async () => {
    const r = await Q.findNodes({}, {}, ctx(reader.id));
    expect(r.scope ?? null).toBeNull();
    expect(locsOf(r)).toEqual([`${memA1.id}:alpha`, `${memA2.id}:alpha`]);
  });
});

describe('a scope named in the call', () => {
  it('narrows to the scope, discloses what was dropped, and never grants', async () => {
    const s = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [personal.urn, memA2.urn] } }, ctx(contributor.id));
    // The author reads both.
    const mine = await Q.findNodes({}, { scope: s.id }, ctx(contributor.id));
    expect(locsOf(mine)).toEqual([`${memA2.id}:alpha`, `${personal.id}:alpha`].sort());
    expect(mine.scope).toMatchObject({ kind: 'scope', source: 'call', label: 'lens', ownerUrn: orgA.urn, droppedCount: 0 });
    expect(mine.degraded ?? null).toBeNull();
    // A fellow member cannot read the personal memory: dropped, counted, flagged — never named.
    const theirs = await Q.findNodes({}, { scope: s.id }, ctx(reader.id));
    expect(locsOf(theirs)).toEqual([`${memA2.id}:alpha`]);
    expect(theirs.scope.droppedCount).toBe(1);
    expect(theirs.scope.memoryUrns).toEqual([memA2.urn]);
    expect(theirs.degraded.split(',')).toContain('scope_narrowed');
  });

  it('filter.memoryIds narrows WITHIN the scope; outside it is empty, still disclosed', async () => {
    const s = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [memA1.urn, memA2.urn] } }, ctx(contributor.id));
    const within = await Q.findNodes({}, { scope: s.id, filter: { memoryIds: [memA2.urn] } }, ctx(reader.id));
    expect(locsOf(within)).toEqual([`${memA2.id}:alpha`]);
    const outside = await Q.findNodes({}, { scope: s.id, filter: { memoryIds: [memB.urn] } }, ctx(reader.id));
    expect(outside.hits).toEqual([]);
    expect(outside.scope.label).toBe('lens');
  });

  it('a bare name resolves in the App context; an unreadable or unknown scope is NOT_FOUND', async () => {
    const s = await M.createScope({}, { input: { name: 'lens', appRef: app.urn, memoryRefs: [memA2.urn] } }, ctx(contributor.id, ['ADMIN']));
    const byName = await Q.findNodes({}, { scope: 'lens', appRef: app.urn }, ctx(reader.id));
    expect(byName.scope.label).toBe('lens');
    expect(locsOf(byName)).toEqual([`${memA2.id}:alpha`]);
    await expect(Q.findNodes({}, { scope: 'lens' }, ctx(reader.id))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    // A stranger to the App cannot read the scope — by id or by name.
    const strangerCtx = ctx(twoOrgs.id);
    await expect(Q.findNodes({}, { scope: s.id }, strangerCtx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(Q.findNodes({}, { scope: 'nope', appRef: app.urn }, ctx(reader.id))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it("`app` is the App's attached memories, needs an App context, and drops what the caller cannot read", async () => {
    const r = await Q.findNodes({}, { scope: 'app', appRef: app.urn }, ctx(reader.id));
    expect(r.scope).toMatchObject({ kind: 'app', label: app.urn });
    expect(locsOf(r)).toEqual([`${memA1.id}:alpha`]);
    await expect(Q.findNodes({}, { scope: 'app' }, ctx(reader.id))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('`global` is the organization view: orgId, else the single membership, else ORG_REQUIRED', async () => {
    const named = await Q.findNodes({}, { scope: 'global', orgId: orgA.urn }, ctx(twoOrgs.id));
    expect(named.scope).toMatchObject({ kind: 'global', label: orgA.urn });
    expect(locsOf(named)).toEqual([`${memA1.id}:alpha`, `${memA2.id}:alpha`]);
    const single = await Q.findNodes({}, { scope: 'global' }, ctx(reader.id));
    expect(single.scope.label).toBe(orgA.urn);
    await expect(Q.findNodes({}, { scope: 'global' }, ctx(twoOrgs.id))).rejects.toMatchObject({ extensions: { code: 'ORG_REQUIRED' } });
  });

  it("globalSearch's memory + node slices run under the same scope and disclose it", async () => {
    const s = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [personal.urn, memA2.urn] } }, ctx(contributor.id));
    const r = await Q.globalSearch({}, { query: 'alpha', entityTypes: ['node'], scope: s.id }, ctx(reader.id));
    expect(r.scope).toMatchObject({ kind: 'scope', label: 'lens', droppedCount: 1 });
    expect(r.degraded).toContain('scope_narrowed');
    expect(r.hits.map((h: any) => h.memoryId ?? h.id)).toHaveLength(1);
    const unscoped = await Q.globalSearch({}, { query: 'alpha', entityTypes: ['node'] }, ctx(reader.id));
    expect(unscoped.scope ?? null).toBeNull();
    expect(unscoped.hits.length).toBe(2);
  });
});
