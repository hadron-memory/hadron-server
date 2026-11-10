/**
 * Spec 049 Phase 3b — a headless run's scope (D-2026-09-13-004).
 *
 * Pinned: a trigger's scopeRef must be readable AND owned by the App's
 * context (a scope from elsewhere is refused with no existence tell); the
 * scope is SNAPSHOTTED onto the run at mint and a later edit does not change
 * it; a spawned child inherits the snapshot verbatim; `resolveRunScope`
 * re-intersects the snapshot with the principal's CURRENT access — a
 * membership revoked after mint drops its memory and is disclosed; no
 * snapshot ⇒ the App's attached memories; `AppRun.scope` renders the same.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { mintAppRun, handleSpawnCompletion } from '../jobs/appRuns.js';
import { runContext } from '../jobs/appRunDeps.js';
import { hadronSpawn } from './runner/tools/index.js';
import { resolveRunScope, resolveScopeForTrigger } from './scopes.js';

const M = resolvers.Mutation as any;
const AppRunType = (resolvers as any).AppRun;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let admin: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };
let memA1: { id: string; urn: string };
let memA2: { id: string; urn: string };
let memB: { id: string; urn: string };
let entry: string;
let scheduleId: string;

const ctx = (userId: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'rs-a', urn: `rs-a-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'rs-b', urn: `rs-b-${t}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 48501, githubUsername: `rs-admin-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'A', urn: `${orgA.urn}:app` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  const ag = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'ag', urn: `${orgA.urn}:ag`, visibility: 'ORGANIZATION' } });
  agent = ag;
  await db.appAgent.create({ data: { appId: app.id, agentId: ag.id } });
  await serveAgentBootPrompt(db, ag.id, 'Test boot prompt.'); // #2712: a run needs a served Agent (R74)
  const mem = (org: { id: string; urn: string }, slug: string) =>
    db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility: 'ORGANIZATION' } });
  memA1 = await mem(orgA, 'a1');
  memA2 = await mem(orgA, 'a2');
  memB = await mem(orgB, 'b');
  await db.agentMemoryItem.create({ data: { id: generateId(), agentId: ag.id, memoryId: memA1.id, role: 'read' } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: memA1.id, loc: 'tasks:go', name: 'go', nodeType: 'task', content: 'go', isRunnable: true } });
  entry = `hrn:node:${memA1.urn}:${node.loc}`;
  // #2479: scheduled mints read their budget from a durable trigger, never a missing-id fallback.
  scheduleId = (await db.agentSchedule.create({ data: {
    id: generateId(), organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id,
    name: 'scope fixture', cron: '* * * * *', entryNodeUrn: entry,
  } })).id;
});

describe('a trigger names a scope', () => {
  it('must be readable and owned by the App context; a foreign scope is refused with no tell', async () => {
    const own = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [memA1.urn, memB.urn] } }, ctx(admin.id));
    expect(await resolveScopeForTrigger(ctx(admin.id), app.id, own.id)).toBe(own.id);
    expect(await resolveScopeForTrigger(ctx(admin.id), app.id, 'lens')).toBe(own.id);
    // Readable by the admin (a member of orgB) — but orgB is not this App's context.
    const foreign = await M.createScope({}, { input: { name: 'other', organizationRef: orgB.urn, memoryRefs: [memB.urn] } }, ctx(admin.id));
    await expect(resolveScopeForTrigger(ctx(admin.id), app.id, foreign.id)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(resolveScopeForTrigger(ctx(admin.id), app.id, `nope-${generateId()}`)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    const schedule = await M.createAgentSchedule({}, { input: { appRef: app.urn, name: 's', cron: '0 9 * * *', entryNodeUrn: entry, scopeRef: 'lens' } }, ctx(admin.id));
    expect(schedule.scopeId).toBe(own.id);
    const cleared = await M.updateAgentSchedule({}, { id: schedule.id, input: { scopeRef: '' } }, ctx(admin.id));
    expect(cleared.scopeId).toBeNull();
  });
});

describe('the snapshot on the run', () => {
  it('is taken at mint, survives a later edit, and is inherited by a spawned child', async () => {
    const s = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [memA2.urn, memA1.urn] } }, ctx(admin.id));
    const run = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id,
      triggerKind: 'SCHEDULE', triggerId: scheduleId, entryNodeUrn: entry, scopeId: s.id, publish: false,
    });
    expect(run.scopeSnapshot).toMatchObject({ scopeId: s.id, name: 'lens', ownerType: 'ORGANIZATION', memoryIds: [memA2.id, memA1.id] });

    await M.updateScope({}, { ref: s.id, input: { memoryRefs: [memB.urn] } }, ctx(admin.id));
    const child = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id,
      triggerKind: 'SPAWN', triggerId: run.id, parentRunId: run.id, entryNodeUrn: entry,
      scopeSnapshot: run.scopeSnapshot, publish: false,
    });
    // The child carries the PARENT's list, not the scope's edited one.
    expect((child.scopeSnapshot as any).memoryIds).toEqual([memA2.id, memA1.id]);
    // A trigger whose scope has been deleted mints no snapshot (⇒ app).
    await M.deleteScope({}, { ref: s.id }, ctx(admin.id));
    const later = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, scopeId: s.id, publish: false,
    });
    expect(later.scopeSnapshot).toBeNull();
  });

  it('is data, never a grant: resolveRunScope re-intersects with CURRENT access and discloses the drop', async () => {
    const s = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [memA1.urn, memB.urn] } }, ctx(admin.id));
    const run = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, scopeId: s.id, publish: false,
    });
    const before = await resolveRunScope(ctx(admin.id), run);
    expect(before).toMatchObject({ kind: 'scope', source: 'trigger', label: 'lens', ownerUrn: orgA.urn, memoryIds: [memA1.id, memB.id], droppedCount: 0 });
    // Revoked from orgB after mint: memB leaves the run's view on the next resolution.
    await db.orgMember.updateMany({ where: { organizationId: orgB.id, userId: admin.id }, data: { deletedAt: new Date() } });
    const after = await resolveRunScope(ctx(admin.id), run);
    expect(after.memoryIds).toEqual([memA1.id]);
    expect(after.droppedCount).toBe(1);
    const info = await AppRunType.scope(run, {}, ctx(admin.id));
    expect(info).toMatchObject({ kind: 'scope', source: 'trigger', label: 'lens', memoryUrns: [memA1.urn], droppedCount: 1 });
  });

  it('no snapshot ⇒ the App\'s attached memories, and AppRun.scope is null', async () => {
    const run = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false,
    });
    expect(run.scopeSnapshot).toBeNull();
    const r = await resolveRunScope(ctx(admin.id), run);
    expect(r).toMatchObject({ kind: 'app', source: 'trigger', memoryIds: [memA1.id] });
    expect(await AppRunType.scope(run, {}, ctx(admin.id))).toBeNull();
  });
});

describe('hadron_spawn is scope-bearing (plan §3.3)', () => {
  it('an explicit scope_ref overrides the parent lens for every child AND every callback run; absent, the parent snapshot flows to all', async () => {
    const lens = await M.createScope({}, { input: { name: 'lens', organizationRef: orgA.urn, memoryRefs: [memA1.urn] } }, ctx(admin.id));
    const other = await M.createScope({}, { input: { name: 'other', organizationRef: orgA.urn, memoryRefs: [memA2.urn] } }, ctx(admin.id));
    const parent = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id,
      triggerKind: 'SCHEDULE', triggerId: scheduleId, entryNodeUrn: entry, scopeId: lens.id, publish: false,
    });
    const toolCtx = (run: typeof parent) => ({ log: () => {}, db, run, principal: runContext(db, run) });
    await hadronSpawn.execute(toolCtx(parent), {
      items: ['x', 'y'], process_item: entry, callback: entry, item_callback: entry, scope_ref: 'other',
    });
    const kids = (await db.appRun.findMany({ where: { parentRunId: parent.id } })).filter((r) => !(r.eventData as any)?.__spawnCallback);
    expect(kids).toHaveLength(2);
    for (const k of kids) expect((k.scopeSnapshot as any).scopeId).toBe(other.id);
    // Children terminate → item callbacks and the final callback mint under the SAME lens.
    for (const k of kids) {
      await db.appRun.update({ where: { id: k.id }, data: { status: 'COMPLETED' } });
      await handleSpawnCompletion(db, k.id);
    }
    const coordination = (await db.appRun.findMany({ where: { parentRunId: parent.id } })).filter((r) => (r.eventData as any)?.__spawnCallback);
    expect(coordination).toHaveLength(3);
    for (const c of coordination) expect((c.scopeSnapshot as any).scopeId).toBe(other.id);

    // No override: the parent's own snapshot, on children and callbacks alike.
    const parent2 = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id,
      triggerKind: 'SCHEDULE', triggerId: scheduleId, entryNodeUrn: entry, scopeId: lens.id, publish: false,
    });
    await hadronSpawn.execute(toolCtx(parent2), { items: ['x'], process_item: entry, callback: entry });
    const [kid] = (await db.appRun.findMany({ where: { parentRunId: parent2.id } })).filter((r) => !(r.eventData as any)?.__spawnCallback);
    expect((kid.scopeSnapshot as any).scopeId).toBe(lens.id);
    await db.appRun.update({ where: { id: kid.id }, data: { status: 'COMPLETED' } });
    await handleSpawnCompletion(db, kid.id);
    const [cb] = (await db.appRun.findMany({ where: { parentRunId: parent2.id } })).filter((r) => (r.eventData as any)?.__spawnCallback);
    expect((cb.scopeSnapshot as any).scopeId).toBe(lens.id);

    // A scope_ref outside the App's context is refused, minting nothing.
    const parent3 = await mintAppRun(db, {
      organizationId: orgA.id, appId: app.id, agentId: agent.id, userId: admin.id, triggerKind: 'MANUAL', entryNodeUrn: entry, publish: false,
    });
    await expect(hadronSpawn.execute(toolCtx(parent3), { items: ['x'], process_item: entry, scope_ref: 'nope' })).rejects.toThrow(/No readable scope/);
    expect(await db.appRun.count({ where: { parentRunId: parent3.id } })).toBe(0);
  });
});
