/** #2063 P4: advice requires the writer's own history read, never a privileged probe. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import * as warnings from './plainPinWarnings.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let userId: string;
let memoryId: string;
const ctx = (id = userId): Context => ({ db, userId: id, roles: ['READER'] });
const check = (text: string, c = ctx()) => warnings.plainPinWarnings(c, { memoryId }, text);
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Pin warnings', urn: 'pins2063.example' } });
  const user = await db.user.create({ data: { githubId: 206302, githubUsername: 'pins2063', handle: 'pins2063', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'pins2063' }, ctx())).id;
});
it('warns for a readable plain revision with fixed text and no target details', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Secret title', content: 'Secret text' } });
  expect(await check('{{> target rev=1}}')).toEqual([{ code: 'INCLUDE_PIN_PRUNABLE', text: 'A pinned include revision carries no recorded approval or signature and may be automatically pruned, breaking the include.' }]);
});
it('omits warnings for missing or unreadable history uniformly', async () => {
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  const other = await db.user.create({ data: { githubId: 206303, githubUsername: 'other2063', handle: 'other2063', roles: [] } });
  expect(await check('{{> target rev=1}}', ctx(other.id))).toEqual([]);
  expect(await check('{{> missing rev=1}}', ctx(other.id))).toEqual([]);
  expect(await check('{{> target rev=999}}')).toEqual([]);
});
it('no-pin writes and recorded-approval pins have no false warning; covered siblings still warn', async () => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, ctx());
  expect(await check('{{> target}}')).toEqual([]);
  expect(await check('{{> target rev=1 approved}}')).toEqual([]);
  await resolvers.Mutation.updateNode(null, { input: { id: n.id, tags: ['metadata'] } }, ctx());
  expect(await check('{{> target rev=2 approved}}')).toHaveLength(1);
});
it('a moved snapshot is concealed unless both current and capture memories are readable', async () => {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc: 'target', name: 'Target', content: 'text' } });
  await resolvers.Mutation.updateNode(null, { input: { id: n.id, content: 'new' } }, ctx());
  const foreignOwner = await db.user.create({ data: { githubId: 206304, githubUsername: 'foreign2063', handle: 'foreign2063', roles: [] } });
  const foreign = await db.memory.create({ data: { id: generateId(), name: 'foreign', urn: 'hrn:mem:pins2063.example:foreign', class: 'private', userId: foreignOwner.id } });
  await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { memoryId: foreign.id } });
  expect(await check('{{> target rev=1}}')).toEqual([]);
});
