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
    expect(locsOf(r)).toEqual([`${memA1.id}:alpha`, `${memA2.id}:alpha`].sort());
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

  it("`app` applies the install-admissibility rule: a cross-org Agent without a live AgentOrgGrant contributes nothing (Copilot on #1161)", async () => {
    const agentB = await db.agent.create({ data: { id: generateId(), organizationId: orgB.id, name: 'agB', urn: `${orgB.urn}:agB`, visibility: 'PUBLIC' } });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agentB.id, memoryId: memB.id, role: 'read' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agentB.id } });
    await db.appMember.create({ data: { appId: app.id, userId: twoOrgs.id, role: 'member' } });
    // twoOrgs can READ memB (member of orgB) — so only the lens, not the access
    // intersection, keeps it out of this App's scope.
    const r = await Q.findNodes({}, { scope: 'app', appRef: app.urn }, ctx(twoOrgs.id));
    expect(r.scope.memoryUrns).toEqual([memA1.urn]);
    expect(locsOf(r)).toEqual([`${memA1.id}:alpha`]);
  });

  it('`global` is the organization view: orgId, else the single membership, else ORG_REQUIRED', async () => {
    const named = await Q.findNodes({}, { scope: 'global', orgId: orgA.urn }, ctx(twoOrgs.id));
    expect(named.scope).toMatchObject({ kind: 'global', label: orgA.urn });
    expect(locsOf(named)).toEqual([`${memA1.id}:alpha`, `${memA2.id}:alpha`].sort());
    const single = await Q.findNodes({}, { scope: 'global' }, ctx(reader.id));
    expect(single.scope.label).toBe(orgA.urn);
    // The envelope says what was searched — the org's readable memories, materialised.
    expect(new Set(single.scope.memoryUrns)).toEqual(new Set([memA1.urn, memA2.urn]));
    await expect(Q.findNodes({}, { scope: 'global' }, ctx(twoOrgs.id))).rejects.toMatchObject({ extensions: { code: 'ORG_REQUIRED' } });
    // An orgId that names nothing is a FINAL refusal — never the single membership instead (Codex on #1161).
    await expect(Q.findNodes({}, { scope: 'global', orgId: `no-such-${generateId()}` }, ctx(reader.id))).rejects.toMatchObject({ extensions: { code: 'ORG_REQUIRED' } });
  });

  it("an App key's `global` is its own App's organization, on both surfaces (Codex on #1161)", async () => {
    const appKey = { db, appId: app.id, roles: [] } as unknown as Context;
    const nodes = await Q.findNodes({}, { scope: 'global' }, appKey);
    expect(nodes.scope).toMatchObject({ kind: 'global', label: orgA.urn });
    // #1376 (R201): the key resolves its App's org as scope but, with no user behind it, is not admitted to the
    // org memories its Agent's items link, so the search finds nothing in them.
    expect(nodes.hits).toHaveLength(0);
    const gs = await Q.globalSearch({}, { query: 'alpha', entityTypes: ['node'], scope: 'global' }, appKey);
    expect(gs.scope).toMatchObject({ kind: 'global', label: orgA.urn });
    expect(gs.hits).toHaveLength(0);
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

describe('#1173 — a refusal states the condition, never another surface\'s remedy', () => {
  // The CLI, MCP and the portal read the SAME string, so a remedy phrased in
  // one surface's vocabulary is unactionable on the other two: `appRef` and
  // `orgId` are GraphQL argument names, `hadron_set_active_org` is an MCP tool.
  // A CLI user can type none of them; a portal user can click none of them.
  // `conventions:the-error-code-is-the-contract-the-prose-is-not`.
  const FOREIGN_VOCABULARY = /appRef|orgId|scopeRef|hadron_|\(MCP\)|\(GraphQL\)/;

  const refusalOf = async (call: Promise<unknown>) => {
    try {
      await call;
      throw new Error('expected a refusal');
    } catch (e) {
      return e as { message: string; extensions?: Record<string, unknown> };
    }
  };

  it('`app` without an App context names the condition and carries `missing`', async () => {
    const err = await refusalOf(Q.findNodes({}, { scope: 'app' }, ctx(reader.id)));
    expect(err.message).toBe('scope "app" needs an App context.');
    expect(err.message).not.toMatch(FOREIGN_VOCABULARY);
    // The structured carrier each client renders in its OWN words.
    expect(err.extensions).toMatchObject({ code: 'BAD_USER_INPUT', missing: 'appContext' });
  });

  it('a bare scope NAME without an App context does the same, and still says an id needs none', async () => {
    const err = await refusalOf(Q.findNodes({}, { scope: 'marketing' }, ctx(reader.id)));
    expect(err.message).not.toMatch(FOREIGN_VOCABULARY);
    expect(err.extensions).toMatchObject({ code: 'BAD_USER_INPUT', missing: 'appContext' });
    // A scope id is a VALUE any surface can supply, so naming it is a fact
    // about scopes rather than an instruction in one client's vocabulary.
    expect(err.message).toContain('a scope id needs none');
  });

  it('`global` with no active org states the condition; memberOrgIds stays the machine-readable half', async () => {
    const err = await refusalOf(Q.findNodes({}, { scope: 'global' }, ctx(twoOrgs.id)));
    expect(err.message).toBe('You belong to 2 organizations and none is active.');
    expect(err.message).not.toMatch(FOREIGN_VOCABULARY);
    expect(err.extensions).toMatchObject({ code: 'ORG_REQUIRED', missing: 'activeOrg' });
    expect((err.extensions?.memberOrgIds as string[]).length).toBe(2);
  });

  it('a NAMED foreign org is not "missing an active org" — the hint is absent there', async () => {
    // Copilot on PR #1175: two refusals share ORG_REQUIRED and only one is
    // about something missing. The caller here DID name an organization; a
    // client told `missing: 'activeOrg'` would prompt for the selection just
    // made — the wrong-remedy defect this whole change is about, one level in.
    // A real organization the caller is not in: the refusal carries the list
    // to choose from, and NO `missing` hint.
    const outside = await db.organization.create({
      data: { id: generateId(), name: 'ss-outside', urn: `ss-outside-${generateId()}` },
    });
    const foreign = await refusalOf(Q.findNodes({}, { scope: 'global', orgId: outside.urn }, ctx(twoOrgs.id)));
    expect(foreign.extensions?.code).toBe('ORG_REQUIRED');
    expect(foreign.extensions).not.toHaveProperty('missing');
    expect((foreign.extensions?.memberOrgIds as string[]).length).toBeGreaterThan(0);
    expect(foreign.message).not.toMatch(FOREIGN_VOCABULARY);
    // A ref that names nothing takes the same branch, so it must not gain the
    // hint either. (Its `memberOrgIds` comes back empty — a separate, older
    // inconsistency in the same refusal, reported rather than changed here.)
    const unknown = await refusalOf(Q.findNodes({}, { scope: 'global', orgId: `no-such-${generateId()}` }, ctx(twoOrgs.id)));
    expect(unknown.extensions?.code).toBe('ORG_REQUIRED');
    expect(unknown.extensions).not.toHaveProperty('missing');
  });
});
