import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

// #1987 (R208 A, cor:api:060:04): the organisation's task catalogue (the org
// Task Nodes page: findNodes with orgId + isRunnable, and the skill export of
// that same org view) lists only the organisation's own memories. A runnable
// node in an App-class memory is never in it, not even for a reader who
// participates in that App; App tasks are found within the App. Test-only pin:
// no audience or gate changes.
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
let orgId: string;
let appMemoryId: string;
let orgMemoryId: string;
let appId: string;
let task: (memoryId: string, loc: string) => Promise<unknown>;
const users: Record<string, string> = {};
// #2884: `operator` is an org READER who is also a platform ADMIN, the one caller here whose read set reaches an
// App-scoped knowledge/group memory (see the #2884 block below).
const context = (who: string): Context => ({ db, userId: users[who], roles: who === 'operator' ? ['ADMIN'] : ['READER'] }) as Context;
const catalogue = (who: string, extra: Record<string, unknown> = {}) =>
  Q.findNodes({}, { orgId, filter: { isRunnable: true, ...extra } }, context(who));
const locs = (result: { hits: { node: { loc: string } }[] }) => result.hits.map(h => h.node.loc).sort();

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), urn: 'catalogue1987.example', name: 'Catalogue' } })).id;
  for (const [who, role] of [['owner', 'OWNER'], ['member', 'READER'], ['participant', 'READER'], ['operator', 'READER']] as const) {
    users[who] = (await db.user.create({ data: { id: generateId(), handle: `catalogue1987-${who}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { userId: users[who], organizationId: orgId, role } });
  }
  appId = (await db.app.create({ data: { id: generateId(), urn: 'catalogue1987.example:app', name: 'App', organizationId: orgId } })).id;
  await db.appMember.create({ data: { appId, userId: users.participant, role: 'member' } });
  orgMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:org', name: 'Org tasks', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } })).id;
  appMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:team', name: 'App team space', class: 'app', organizationId: orgId, appId } })).id;
  task = (memoryId: string, loc: string) => db.node.create({
    data: {
      id: generateId(), memoryId, loc, name: loc, content: `# ${loc}`, isRunnable: true,
      properties: { exports: { claudeSkill: { name: loc.replace(':', '-'), description: `Run ${loc}. Use when asked.`, enable: true } } },
    },
  });
  await task(orgMemoryId, 'tasks:org-task');
  await task(appMemoryId, 'tasks:app-task');
});

describe('#1987 org task catalogue excludes App-memory tasks', () => {
  it('an org member without App participation sees only the org memory task', async () => {
    expect(locs(await catalogue('member'))).toEqual(['tasks:org-task']);
  });

  // An org OWNER (CONTRIBUTOR+) and an AppMember both read the App memory, so
  // each is an App participant: the org catalogue must still not list it.
  it.each(['owner', 'participant'])('%s reads the App memory yet the org catalogue still omits its task', async who => {
    expect(locs(await catalogue(who))).toEqual(['tasks:org-task']);
  });

  // The predefined 'global' ("this organisation") view is the same org narrowing.
  it.each(['owner', 'participant'])('%s: the predefined global view omits the App task too', async who => {
    const hits = await Q.findNodes({}, { scope: 'global', orgId, filter: { isRunnable: true } }, context(who));
    expect(locs(hits)).toEqual(['tasks:org-task']);
  });

  // The global view with NO explicit orgId resolves the org from the caller's
  // single membership and materialises its memory list (LOCAL CR on aa658441).
  it.each(['owner', 'participant'])('%s: global without orgId omits the App task (GraphQL)', async who => {
    const hits = await Q.findNodes({}, { scope: 'global', filter: { isRunnable: true } }, context(who));
    expect(locs(hits)).toEqual(['tasks:org-task']);
  });

  it.each(['owner', 'participant'])('%s: global without orgId omits the App task (MCP hadron_find_nodes)', async who => {
    const srv = createTestableMcpServer({ ...context(who), clientId: `user:${users[who]}` });
    const text = await srv.callToolText('hadron_find_nodes', { scope: 'global', isRunnable: true });
    expect(text).toContain('tasks:org-task');
    expect(text).not.toContain('tasks:app-task');
  });

  // No ruling covers org-scoped NON-runnable search (R208 A is the task
  // catalogue); this pins that the fix leaves it exactly as it was.
  it('org-scoped non-runnable search is unchanged (still reaches an App memory its caller reads)', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: appMemoryId, loc: 'notes:app-note', name: 'note', content: 'note', isRunnable: false } });
    const hits = await Q.findNodes({}, { orgId, filter: { isRunnable: false } }, context('participant'));
    expect(locs(hits)).toEqual(['notes:app-note']);
  });

  it('control: the same participant reaches the App task within the App memory', async () => {
    const hits = await Q.findNodes({}, { filter: { memoryIds: [appMemoryId], isRunnable: true } }, context('participant'));
    expect(locs(hits)).toEqual(['tasks:app-task']);
  });

  it('control: an org member without App participation cannot read the App memory at all', async () => {
    const hits = await Q.findNodes({}, { filter: { memoryIds: [appMemoryId], isRunnable: true } }, context('member'));
    expect(hits.hits).toEqual([]);
  });

  it('the org skill export of the org view lists the org task and never the App task', async () => {
    const ctx = context('owner');
    const created = await M.createScope({}, { input: { name: 'org-export', organizationRef: orgId, memoryRefs: [orgMemoryId] } }, ctx);
    const exported = await Q.skillPlan({}, { input: { intent: 'EXPORT', host: 'claudeSkill', scopeRef: created.id } }, ctx);
    expect(exported.entries.map((e: { urn: string }) => e.urn)).toEqual([expect.stringContaining('tasks:org-task')]);
    expect(JSON.stringify(exported)).not.toContain('tasks:app-task');
  });
});

/**
 * #2884 (coverage left by the #2880 reviews, CHECKED by Xan): the #1987 narrowing keys on `app_id IS NULL`, not on
 * class, so an App-scoped knowledge or group memory (class knowledge/group with appId set, #653) stays out of the org
 * catalogue like a class-app memory does.
 *
 * The caller is `operator` (org READER + platform ADMIN) because it is the one caller whose read set reaches these
 * rows: a person's org arms exclude App-scoped knowledge and group rows even for a MemoryMember
 * (`getOrgReadableMemoryIds`, #653/#1208). For an owner or participant the read gate hides them before the narrowing
 * runs, so a pin on them could not fail when the narrowing is removed. That person-side absence is the rule (#3070,
 * Holger V23) and is pinned in its own block below. The positive controls prove the operator reads each memory, so
 * each catalogue absence is the narrowing's.
 */
describe('#2884 App-scoped knowledge and group memories are not in the org catalogue', () => {
  const ids: Record<'knowledge' | 'group', string> = { knowledge: '', group: '' };
  const loc = { knowledge: 'tasks:app-kb-task', group: 'tasks:app-group-task' } as const;
  beforeEach(async () => {
    ids.knowledge = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:app-kb', name: 'App knowledge', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId, appId } })).id;
    ids.group = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:app-group', name: 'App group', class: 'group', organizationId: orgId, appId } })).id;
    await db.memoryMember.create({ data: { memoryId: ids.group, userId: users.operator, role: 'owner' } });
    await db.memoryMember.create({ data: { memoryId: ids.group, userId: users.owner, role: 'owner' } });
    await db.memoryMember.create({ data: { memoryId: ids.group, userId: users.participant, role: 'reader' } });
    await task(ids.knowledge, loc.knowledge);
    await task(ids.group, loc.group);
  });

  it.each(['knowledge', 'group'] as const)('control: the operator reads the App-scoped %s task by explicit memoryIds', async cls => {
    const hits = await Q.findNodes({}, { filter: { memoryIds: [ids[cls]], isRunnable: true } }, context('operator'));
    expect(locs(hits)).toEqual([loc[cls]]);
  });

  // #3070 (Vera's ruling; Holger V23 "App only, as built"; cor:acl:010:01, cor:dmo:060:01): an App-scoped knowledge or
  // group memory is App-internal. A person reads it neither as an org member (any org role) nor as a MemoryMember of
  // the group (owner, reader), even by naming it. The operator control above is the reader that does reach it.
  describe('#3070 a person never reads an App-scoped knowledge or group memory', () => {
    const cases = [
      ['owner', 'knowledge'], ['owner', 'group'],
      ['participant', 'knowledge'], ['participant', 'group'],
      ['member', 'knowledge'], ['member', 'group'],
    ] as const;
    it.each(cases)('%s gets nothing from the App-scoped %s memory by explicit memoryIds', async (who, cls) => {
      const hits = await Q.findNodes({}, { filter: { memoryIds: [ids[cls]], isRunnable: true } }, context(who));
      expect(hits.hits).toEqual([]);
    });
  });

  it.each(['knowledge', 'group'] as const)('the org catalogue (orgId + isRunnable) omits the App-scoped %s task', async cls => {
    const listed = locs(await catalogue('operator'));
    expect(listed).not.toContain(loc[cls]);
    expect(listed).toContain('tasks:org-task');
  });

  it.each(['knowledge', 'group'] as const)('the predefined global view (no orgId) omits the App-scoped %s task', async cls => {
    const listed = locs(await Q.findNodes({}, { scope: 'global', filter: { isRunnable: true } }, context('operator')));
    expect(listed).not.toContain(loc[cls]);
    expect(listed).toContain('tasks:org-task');
  });

  it.each(['knowledge', 'group'] as const)('MCP hadron_find_nodes over the global view omits the App-scoped %s task', async cls => {
    const srv = createTestableMcpServer({ ...context('operator'), clientId: `user:${users.operator}` });
    const text = await srv.callToolText('hadron_find_nodes', { scope: 'global', isRunnable: true });
    expect(text).toContain('tasks:org-task');
    expect(text).not.toContain(loc[cls]);
  });

  // The org-wide export, built the way the org Task Nodes download builds it: a scope over the org's own memories
  // (`Organization.memories`), then skillPlan EXPORT. There is no server-side export of the predefined `global` view
  // (`skillPlan.scopeRef` takes a persisted Scope id, and `global` is a reserved name). The system-memory half of the
  // portal's set is left out here: it pulls in an App's install memory, hadron-server#3069.
  it.each(['owner', 'operator'])('%s: the org-wide skill export over Organization.memories lists only the org task', async who => {
    const ctx = context(who);
    const org = await Q.organization({}, { ref: orgId }, ctx);
    const memoryRefs = (await (resolvers as any).Organization.memories(org, {}, ctx)).map((m: { id: string }) => m.id);
    expect(memoryRefs).toEqual([orgMemoryId]);
    const created = await M.createScope({}, { input: { name: `org-export-${who}`, organizationRef: orgId, memoryRefs } }, ctx);
    const exported = await Q.skillPlan({}, { input: { intent: 'EXPORT', host: 'claudeSkill', scopeRef: created.id } }, ctx);
    expect(exported.entries.map((e: { urn: string }) => e.urn)).toEqual([expect.stringContaining('tasks:org-task')]);
    const text = JSON.stringify(exported);
    for (const l of [loc.knowledge, loc.group, 'tasks:app-task']) expect(text).not.toContain(l);
  });
});
