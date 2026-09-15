/**
 * Spec 049 Phase 2 — the Scope surface (D-2026-09-13-001 … 005).
 *
 * What is pinned, and why each one matters:
 *   - the owner write gates per tier, and that a READER cannot create;
 *   - reserved names and the per-owner LIVE-row uniqueness (a deleted scope
 *     frees its name — the partial index, not a plain unique);
 *   - a memory the author cannot read is "no match", identical to a
 *     nonexistent one (no existence oracle through memoryRefs);
 *   - the read gate: a non-member sees null and an empty page;
 *   - the projection: another member sees stored ∩ accessible and a COUNT of
 *     the rest — a scope never grants (D-004), never names what it hides;
 *   - name resolution App › Agent › organization, shadowed listed, never
 *     unioned; two Agents owning the name is ambiguous, never guessed;
 *   - winnerFor(loc) honours scope ORDER — the one consumer of order;
 *   - update REPLACES the list; the orgId scope collapses to an empty page for
 *     a non-member.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const S = (resolvers as any).Scope;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let contributor: { id: string };
let reader: { id: string };
let stranger: { id: string };
let app: { id: string; urn: string };
let agent: { id: string; urn: string };
let agent2: { id: string; urn: string };
let memA1: { id: string; urn: string };
let memA2: { id: string; urn: string };
let memB: { id: string; urn: string };
let personal: { id: string; urn: string };

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'sc-a', urn: `sc-a-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'sc-b', urn: `sc-b-${t}` } });
  contributor = await db.user.create({ data: { id: generateId(), githubId: 48101, githubUsername: `sc-contrib-${t}` } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 48102, githubUsername: `sc-reader-${t}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 48103, githubUsername: `sc-stranger-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'CONTRIBUTOR' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'A app', urn: `${orgA.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'member' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'agent', urn: `${orgA.urn}:agent`, visibility: 'ORGANIZATION' } });
  agent2 = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'agent2', urn: `${orgA.urn}:agent2`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const mem = (org: { id: string; urn: string }, slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  memA1 = await mem(orgA, 'a1');
  memA2 = await mem(orgA, 'a2');
  memB = await mem(orgB, 'b');
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:contrib-personal`, name: 'p', class: 'personal', userId: contributor.id, appId: app.id, userMemoryOfAgentId: agent.id },
  });
});

const orgScope = (name = 'marketing', memoryRefs = [memA1.urn]) =>
  M.createScope({}, { input: { name, organizationRef: orgA.urn, memoryRefs } }, ctx(contributor.id));

describe('write gates and names', () => {
  it('an org CONTRIBUTOR creates an org scope; a READER cannot', async () => {
    const s = await orgScope();
    expect(s.organizationId).toBe(orgA.id);
    expect(s.agentId).toBeNull();
    await expect(
      M.createScope({}, { input: { name: 'x', organizationRef: orgA.urn, memoryRefs: [memA1.urn] } }, ctx(reader.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('exactly one owner, a legal name, and the two reserved tokens refused', async () => {
    await expect(
      M.createScope({}, { input: { name: 'x', organizationRef: orgA.urn, appRef: app.urn, memoryRefs: [memA1.urn] } }, ctx(contributor.id)),
    ).rejects.toThrow(/exactly one owner/);
    await expect(orgScope('Not Legal')).rejects.toThrow(/1–64 characters/);
    await expect(orgScope('global')).rejects.toThrow(/reserved/);
    await expect(orgScope('app')).rejects.toThrow(/reserved/);
  });

  it('a name is unique per owner among LIVE rows — deleting frees it', async () => {
    const first = await orgScope();
    await expect(orgScope()).rejects.toMatchObject({ extensions: { code: 'SCOPE_NAME_TAKEN' } });
    // Same name on a different owner is fine (namespaced, not global).
    const onApp = await M.createScope({}, { input: { name: 'marketing', appRef: app.urn, memoryRefs: [memA1.urn] } }, ctx(contributor.id, ['ADMIN']));
    expect(onApp.appId).toBe(app.id);
    expect(await M.deleteScope({}, { ref: first.id }, ctx(contributor.id))).toBe(true);
    const again = await orgScope();
    expect(again.id).not.toBe(first.id);
    expect(await Q.scope({}, { ref: first.id }, ctx(contributor.id))).toBeNull();
  });

  it('a memory the author cannot read reads as "no match", like a nonexistent one', async () => {
    // One at a time: a second promise created before the first is awaited
    // rejects unhandled while the first assertion runs, which CI reports as
    // a failure even though both assertions hold.
    await expect(orgScope('x', [memB.urn])).rejects.toThrow(/No match for memoryRef/);
    await expect(orgScope('y', [`${orgA.urn}:does-not-exist`])).rejects.toThrow(/No match for memoryRef/);
  });
});

describe('read gate and projection — a scope never grants', () => {
  it('a non-member gets null and an empty page; a member reads it', async () => {
    const s = await orgScope();
    expect(await Q.scope({}, { ref: s.id }, ctx(stranger.id))).toBeNull();
    expect(await Q.scopes({}, {}, ctx(stranger.id))).toEqual({ items: [], total: 0 });
    expect((await Q.scope({}, { ref: s.id }, ctx(reader.id)))?.id).toBe(s.id);
    const page = await Q.scopes({}, { filter: { appRef: app.urn } }, ctx(reader.id));
    expect(page.total).toBe(1);
  });

  it('another member sees stored ∩ accessible, and a COUNT of the rest', async () => {
    const s = await orgScope('mixed', [personal.urn, memA1.urn]);
    // The author reads both.
    expect((await S.memories(s, {}, ctx(contributor.id))).map((e: any) => e.memory.id)).toEqual([personal.id, memA1.id]);
    expect(await S.hiddenMemoryCount(s, {}, ctx(contributor.id))).toBe(0);
    // A fellow member cannot read the author's personal memory: dropped, counted, never named.
    const entries = await S.memories(s, {}, ctx(reader.id));
    expect(entries.map((e: any) => e.memory.id)).toEqual([memA1.id]);
    expect(entries[0].position).toBe(1);
    expect(await S.hiddenMemoryCount(s, {}, ctx(reader.id))).toBe(1);
    expect(await S.memoryCount(s, {}, ctx(reader.id))).toBe(2);
    const ex = await Q.scopeExplain({}, { scopeRef: s.id }, ctx(reader.id));
    expect(ex.memories.map((m: any) => m.id)).toEqual([memA1.id]);
    expect(ex.droppedCount).toBe(1);
  });

  it('impersonation is bounded to the ONE shared org and can never write (#876)', async () => {
    const s = await orgScope();
    const onApp = await M.createScope({}, { input: { name: 'apponly', appRef: app.urn, memoryRefs: [memA1.urn] } }, ctx(contributor.id, ['ADMIN']));
    const support = (sharedOrgId: string): Context =>
      ({ db, userId: reader.id, roles: [], impersonation: { orgId: sharedOrgId, sessionId: 'sup', adminUserId: contributor.id } }) as unknown as Context;
    // Scoped to orgA: the target's in-org scopes are visible (read-only support).
    const inScope = await Q.scopes({}, {}, support(orgA.id));
    expect(new Set(inScope.items.map((x: any) => x.id))).toEqual(new Set([s.id, onApp.id]));
    // Scoped to orgB: the target's orgA memberships must not leak through.
    expect(await Q.scopes({}, {}, support(orgB.id))).toEqual({ items: [], total: 0 });
    expect(await Q.scope({}, { ref: s.id }, support(orgB.id))).toBeNull();
    // And a support view writes nothing, whatever org it shares.
    await expect(
      M.createScope({}, { input: { name: 'z', organizationRef: orgA.urn, memoryRefs: [memA1.urn] } }, support(orgA.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('orgId collapses to an empty page for a non-member (no disclosure)', async () => {
    await orgScope();
    expect(await Q.scopes({}, { orgId: orgA.urn }, ctx(stranger.id))).toEqual({ items: [], total: 0 });
    expect((await Q.scopes({}, { orgId: orgA.urn }, ctx(reader.id))).total).toBe(1);
  });
});

describe('name resolution in an App context — App › Agent › organization, never unioned', () => {
  it('the App-owned scope wins and shadows the Agent- and org-owned ones', async () => {
    const admin = ctx(contributor.id, ['ADMIN']);
    const onOrg = await orgScope('marketing', [memA1.urn]);
    const onAgent = await M.createScope({}, { input: { name: 'marketing', agentRef: agent.urn, memoryRefs: [memA2.urn] } }, admin);
    const onApp = await M.createScope({}, { input: { name: 'marketing', appRef: app.urn, memoryRefs: [memA1.urn, memA2.urn] } }, admin);

    const ex = await Q.scopeExplain({}, { name: 'marketing', appRef: app.urn }, ctx(reader.id));
    expect(ex.scope.id).toBe(onApp.id);
    expect(ex.resolvedVia).toBe('APP');
    expect(ex.shadowed.map((s: any) => s.id)).toEqual([onAgent.id, onOrg.id]);
    // Never unioned: the winner's list, nothing folded in from the losers.
    expect(ex.memories.map((m: any) => m.id)).toEqual([memA1.id, memA2.id]);

    await M.deleteScope({}, { ref: onApp.id }, admin);
    const next = await Q.scopeExplain({}, { name: 'marketing', appRef: app.urn }, ctx(reader.id));
    expect(next.scope.id).toBe(onAgent.id);
    expect(next.resolvedVia).toBe('AGENT');
    expect(next.memories.map((m: any) => m.id)).toEqual([memA2.id]);
  });

  it('two installed Agents owning the name is AMBIGUOUS — chosen by id, never guessed', async () => {
    const admin = ctx(contributor.id, ['ADMIN']);
    await db.appAgent.create({ data: { appId: app.id, agentId: agent2.id } });
    await M.createScope({}, { input: { name: 'marketing', agentRef: agent.urn, memoryRefs: [memA1.urn] } }, admin);
    await M.createScope({}, { input: { name: 'marketing', agentRef: agent2.urn, memoryRefs: [memA2.urn] } }, admin);
    await expect(Q.scopeExplain({}, { name: 'marketing', appRef: app.urn }, ctx(reader.id))).rejects.toMatchObject({
      extensions: { code: 'SCOPE_NAME_AMBIGUOUS' },
    });
  });

  it("an App the caller cannot read is no context — no tell from a PUBLIC Agent's scope (Codex on #1160)", async () => {
    // A public Agent's scope is readable by anyone; naming a guessed App must
    // not reveal whether that Agent is installed there.
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    await M.createScope({}, { input: { name: 'pub', agentRef: agent.urn, memoryRefs: [memA1.urn] } }, ctx(contributor.id, ['ADMIN']));
    expect(await Q.scopes({}, { filter: { appRef: app.urn } }, ctx(stranger.id))).toEqual({ items: [], total: 0 });
    expect(await Q.scopeExplain({}, { name: 'pub', appRef: app.urn }, ctx(stranger.id))).toBeNull();
    // The scope itself stays readable directly — the gate is on the App context.
    expect((await Q.scopes({}, { filter: { ownerType: 'AGENT', ownerRef: agent.urn } }, ctx(stranger.id))).total).toBe(1);
  });

  it('a soft-deleted memory leaves the scope for everyone — not counted, not hidden (Codex on #1160)', async () => {
    const s = await orgScope('tomb', [memA1.urn, memA2.urn]);
    await db.memory.update({ where: { id: memA2.id }, data: { deletedAt: new Date() } });
    expect(await S.memoryCount(s, {}, ctx(contributor.id))).toBe(1);
    expect(await S.hiddenMemoryCount(s, {}, ctx(contributor.id))).toBe(0);
    const ex = await Q.scopeExplain({}, { scopeRef: s.id }, ctx(contributor.id));
    expect(ex.memories.map((m: any) => m.id)).toEqual([memA1.id]);
    expect(ex.droppedCount).toBe(0);
  });

  it('a name needs an App context on GraphQL', async () => {
    await expect(Q.scopeExplain({}, { name: 'marketing' }, ctx(reader.id))).rejects.toThrow(/needs an App context/);
  });
});

describe('order — the one thing only the customization operation consumes', () => {
  it('winnerFor(loc) is the FIRST memory in scope order holding the address', async () => {
    for (const m of [memA1, memA2]) {
      await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'tasks:brief', name: 'brief', nodeType: 'info' } });
    }
    const s = await orgScope('ordered', [memA2.urn, memA1.urn]);
    const ex = await Q.scopeExplain({}, { scopeRef: s.id, loc: 'tasks:brief' }, ctx(contributor.id));
    expect(ex.winner.id).toBe(memA2.id);
    // Reorder via update — the input IS the new order.
    await M.updateScope({}, { ref: s.id, input: { memoryRefs: [memA1.urn, memA2.urn] } }, ctx(contributor.id));
    const after = await Q.scopeExplain({}, { scopeRef: s.id, loc: 'tasks:brief' }, ctx(contributor.id));
    expect(after.winner.id).toBe(memA1.id);
    const none = await Q.scopeExplain({}, { scopeRef: s.id, loc: 'tasks:nowhere' }, ctx(contributor.id));
    expect(none.winner).toBeNull();
  });
});
