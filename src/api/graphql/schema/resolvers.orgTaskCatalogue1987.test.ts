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
const users: Record<string, string> = {};
const context = (who: string): Context => ({ db, userId: users[who], roles: ['READER'] }) as Context;
const catalogue = (who: string, extra: Record<string, unknown> = {}) =>
  Q.findNodes({}, { orgId, filter: { isRunnable: true, ...extra } }, context(who));
const locs = (result: { hits: { node: { loc: string } }[] }) => result.hits.map(h => h.node.loc).sort();

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), urn: 'catalogue1987.example', name: 'Catalogue' } })).id;
  for (const [who, role] of [['owner', 'OWNER'], ['member', 'READER'], ['participant', 'READER']] as const) {
    users[who] = (await db.user.create({ data: { id: generateId(), handle: `catalogue1987-${who}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { userId: users[who], organizationId: orgId, role } });
  }
  const appId = (await db.app.create({ data: { id: generateId(), urn: 'catalogue1987.example:app', name: 'App', organizationId: orgId } })).id;
  await db.appMember.create({ data: { appId, userId: users.participant, role: 'member' } });
  orgMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:org', name: 'Org tasks', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgId } })).id;
  appMemoryId = (await db.memory.create({ data: { id: generateId(), urn: 'catalogue1987.example:team', name: 'App team space', class: 'app', organizationId: orgId, appId } })).id;
  const task = (memoryId: string, loc: string) => db.node.create({
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
