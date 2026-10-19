/** #1835: bare references stay in the includer's memory AND its read filter. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { compileTemplate } from '../../../lib/template.js';
import { chatScopeAccessFilter } from './chat-scope.js';
import { BROKEN_INCLUDE_NOTICE as N } from '../../../lib/includes/spliceIncludes.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
let alpha: string, beta: string, shared: string, alphaOnly: string, parent: string, including: string;
const template = '{{> chipcross}} / {{chipcross.field}} / {{defaultField}}';
beforeEach(async () => {
  await cleanDb(db);
  const a = await db.organization.create({ data: { name: 'Alpha', urn: 'template-alpha' } });
  const b = await db.organization.create({ data: { name: 'Beta', urn: 'template-beta' } });
  shared = (await db.user.create({ data: { handle: 'template-shared' } })).id;
  alphaOnly = (await db.user.create({ data: { handle: 'template-alpha-only' } })).id;
  for (const [organizationId, userId] of [[a.id, shared], [b.id, shared], [a.id, alphaOnly]]) {
    await db.orgMember.create({ data: { organizationId, userId, role: 'READER' } });
  }
  alpha = (await db.memory.create({ data: { name: 'Alpha', urn: 'template-alpha:knowledge', organizationId: a.id, class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  beta = (await db.memory.create({ data: { name: 'Beta', urn: 'template-beta:knowledge', organizationId: b.id, class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  // Foreign rows first: reproduces Chip's later-added-local-target case.
  await db.node.create({ data: { memoryId: beta, loc: 'chipcross', name: 'Foreign', content: 'FOREIGN_PARTIAL_SENTINEL', data: { field: 'FOREIGN_DATA_SENTINEL' } } });
  await db.node.create({ data: { memoryId: beta, loc: 'data', name: 'Foreign defaults', data: { defaultField: 'FOREIGN_DEFAULT_SENTINEL' } } });
  parent = (await createDbNode(db, { memoryId: alpha, loc: 'qa', name: 'Parent' })).id;
  including = (await createDbNode(db, { memoryId: alpha, loc: 'qa:include', name: 'Including', content: template })).id;
});
const context = (userId: string): Context => ({ db, userId, roles: ['READER'] });
async function addLocal() {
  await db.node.create({ data: { memoryId: alpha, loc: 'chipcross', name: 'Local', content: 'LOCAL_PARTIAL_SENTINEL', data: { field: 'LOCAL_DATA_SENTINEL' } } });
  await db.node.create({ data: { memoryId: alpha, loc: 'data', name: 'Local defaults', data: { defaultField: 'LOCAL_DEFAULT_SENTINEL' } } });
}
const local = 'LOCAL_PARTIAL_SENTINEL / LOCAL_DATA_SENTINEL / LOCAL_DEFAULT_SENTINEL';

describe('#1835 real GraphQL resolver reads', () => {
  it.each(['node', 'nextNode'])('%s cannot borrow foreign refs, before or after same-loc local rows exist', async surface => {
    // The row keeps its stored text; Node.content renders it (#2041).
    const read = async (userId: string) => {
      const row = surface === 'node'
        ? await resolvers.Query.node({}, { ref: including }, context(userId))
        : await resolvers.Query.nextNode({}, { parentRef: parent }, context(userId));
      return row && { content: await resolvers.Node.content(row as never, {}, context(userId)) };
    };
    for (const userId of [shared, alphaOnly]) expect((await read(userId))?.content).toBe(`${N} /  / `);
    await addLocal();
    for (const userId of [shared, alphaOnly]) expect((await read(userId))?.content).toBe(local);
  });
  it('raw node read preserves the stored template', async () => {
    expect((await resolvers.Query.node({}, { ref: including, raw: true }, context(shared)))?.content).toBe(template);
  });
});

describe('#1835 compiler siblings with real database lookups', () => {
  it('retains the authorization filter even when the local target exists', async () => {
    await addLocal();
    expect(await compileTemplate(template, null, alpha, db, { memoryId: { in: [beta] } })).toBe(`${N} /  / `);
    expect(await compileTemplate(template, null, alpha, db, { memoryId: { in: [alpha, beta] }, NOT: { loc: { in: ['data', 'chipcross'] } } })).toBe(`${N} /  / `);
  });
  it('keeps shared-chat D5 filtering while narrowing bare refs to the holding memory', async () => {
    await addLocal();
    const filter = chatScopeAccessFilter(
      { scope: 'shared', memoryId: alpha, appId: 'fixture-app', authorUserId: shared, agentId: 'fixture-agent' },
      { knowledgeMemoryIds: [beta], systemMemoryId: null, appClassMemoryId: alpha },
    );
    expect(filter.memoryId.in).toContain(beta);
    expect(await compileTemplate(template, null, alpha, db, filter)).toBe(local);
    const excluded = chatScopeAccessFilter(
      { scope: 'shared', memoryId: beta, appId: 'fixture-app', authorUserId: shared, agentId: 'fixture-agent' },
      { knowledgeMemoryIds: [], systemMemoryId: null, appClassMemoryId: beta },
    );
    expect(excluded.memoryId.in).not.toContain(alpha);
    expect(await compileTemplate(template, null, alpha, db, excluded)).toBe(`${N} /  / `);
  });
  it('keeps the run/preview empty-filter path local and honors own-data precedence and soft deletion', async () => {
    await addLocal();
    expect(await compileTemplate(template, null, alpha, db, {})).toBe(local);
    expect(await compileTemplate('{{defaultField}}', { defaultField: 'OWN' }, alpha, db, { memoryId: { in: [alpha, beta] } })).toBe('OWN');
    await db.node.updateMany({ where: { memoryId: alpha, loc: { in: ['data', 'chipcross'] } }, data: { deletedAt: new Date() } });
    expect(await compileTemplate(template, null, alpha, db, { memoryId: { in: [alpha, beta] } })).toBe(`${N} /  / `);
  });
});
