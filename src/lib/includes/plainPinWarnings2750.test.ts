/** #2750: history admission and each redundant moved-capture defense are pinned separately. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { buildNodeRevisionSnapshot } from '../nodeRevisionSnapshot.js';
import { createOperatorConversionContext } from '../auth/operatorConversion.js';
import { getAccessibleMemoryIds, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import * as history from '../../api/graphql/schema/resolvers.query.node.js';
import { plainPinWarnings } from './plainPinWarnings.js';

const EXPECTED = [{
  code: 'include.pin.unkept',
  text: 'A pinned include revision carries no recorded approval or signature and may be automatically pruned, breaking the include.',
}];
let reader: Context;
let memoryId: string;
let foreignId: string;
let readableForeignId: string;

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: {
    githubId: 275001, githubUsername: 'pins2750', handle: 'pins2750', roles: [],
  } });
  const other = await db.user.create({ data: {
    githubId: 275002, githubUsername: 'foreign2750', handle: 'foreign2750', roles: [],
  } });
  const org = await db.organization.create({ data: {
    id: generateId(), name: 'History gate pins', urn: 'pins2750.example',
  } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: {
    id: generateId(), name: 'Current', urn: 'pins2750.example:current', class: 'knowledge', organizationId: org.id,
  } })).id;
  readableForeignId = (await db.memory.create({ data: {
    id: generateId(), name: 'Readable capture', urn: 'pins2750.example:readable', class: 'knowledge', organizationId: org.id,
  } })).id;
  foreignId = (await db.memory.create({ data: {
    id: generateId(), name: 'Private capture', urn: 'pins2750.example:private', class: 'private',
    userId: other.id, ownerUserId: other.id,
  } })).id;
  reader = { db, userId: user.id, roles: ['READER'] };
});
afterEach(() => vi.restoreAllMocks());

async function movedCapture(captureMemoryId: string) {
  const target = await db.node.create({ data: {
    id: generateId(), memoryId, loc: 'target', name: 'Private capture title', content: 'Current body', revSeq: 2,
  } });
  const snapshot = await db.nodeRevision.create({ data: {
    id: generateId(), revNo: 1,
    ...buildNodeRevisionSnapshot({ ...target, memoryId: captureMemoryId, content: 'Captured body' }, { userId: reader.userId }),
  } });
  return { target, snapshot };
}

// The internal mark is the only current producer of accessible=null. Its factory
// supplies no reader role, so that unmodified principal cannot read history.
// Add READER only in this fixture to exercise a scope that genuinely admits both
// the warning and nodeRevisions; this changes no request/production authority.
function unrestrictedReader(): Context {
  return { ...createOperatorConversionContext(db), roles: ['READER'] };
}

it('warns an unrestricted history reader about a readable plain foreign capture (red on main)', async () => {
  const { target, snapshot } = await movedCapture(foreignId);
  const principal = unrestrictedReader();
  const scope = await history.nodeRevisionsScope(principal, target.id);
  expect(scope?.accessible).toBeNull();
  expect(scope?.canRead(foreignId)).toBe(true);
  const revisions = await history.nodeQueries.nodeRevisions(null, { nodeRef: target.id }, principal);
  expect(revisions).toEqual([expect.objectContaining({ id: snapshot.id, content: 'Captured body' })]);
  expect(await plainPinWarnings(principal, { memoryId }, '{{> target rev=1}}')).toEqual(EXPECTED);
});

it('the ordinary operator has no reader role and cannot use unrestricted history advice', async () => {
  const { target } = await movedCapture(foreignId);
  const operator = createOperatorConversionContext(db);
  expect(await getAccessibleMemoryIds(operator)).toBeNull();
  await expect(history.nodeQueries.nodeRevisions(null, { nodeRef: target.id }, operator)).rejects.toMatchObject({
    extensions: { code: 'FORBIDDEN' },
  });
  expect(await plainPinWarnings(operator, { memoryId }, '{{> target rev=1}}')).toEqual([]);
});

it.each([undefined, []])('missing/empty roles stay silent for an existing target: %j', async roles => {
  const { target } = await movedCapture(memoryId);
  const principal = { ...reader, roles };
  // This is why the advisory precheck is retained: history admission throws,
  // while the optional post-write advice must remain a silent empty result.
  await expect(history.nodeRevisionsScope(principal, target.id)).rejects.toMatchObject({
    extensions: { code: 'FORBIDDEN' },
  });
  expect(await plainPinWarnings(principal, { memoryId }, '{{> target rev=1}}')).toEqual([]);
});

describe('one moved-snapshot defense at a time, with real PostgreSQL row lookups', () => {
  // canRead and accessible are coherent in today's shared scope, making either
  // defense mask removal of the other. Override just ONE scope projection to
  // make the other defense permissive; the actual revision lookup is never mocked.
  it.each(['restricted', 'unrestricted'] as const)('canRead alone conceals a capture in a %s scope', async kind => {
    const captureId = kind === 'restricted' ? readableForeignId : foreignId;
    const { target, snapshot } = await movedCapture(captureId);
    const principal = kind === 'restricted' ? reader : unrestrictedReader();
    const realScope = await history.nodeRevisionsScope(principal, target.id);
    expect(realScope).not.toBeNull();
    expect(realScope!.canRead(captureId)).toBe(true);
    if (kind === 'restricted') expect(realScope!.accessible).toContain(captureId);
    else expect(realScope!.accessible).toBeNull();
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: snapshot.id } })).toMatchObject({ approvalHash: null });
    const canRead = vi.fn((id: string) => id !== captureId);
    const scope = vi.spyOn(history, 'nodeRevisionsScope').mockResolvedValue({ ...realScope!, canRead });
    expect(await plainPinWarnings(principal, { memoryId }, '{{> target rev=1}}')).toEqual([]);
    expect(scope).toHaveBeenCalledWith(expect.anything(), target.id);
    expect(canRead).toHaveBeenCalledWith(captureId);
  });

  it('the SQL capture-memory filter alone conceals an unreadable capture in a restricted scope', async () => {
    const { target, snapshot } = await movedCapture(foreignId);
    const realScope = await history.nodeRevisionsScope(reader, target.id);
    expect(realScope?.accessible).toContain(memoryId);
    expect(realScope?.accessible).not.toContain(foreignId);
    expect(realScope?.canRead(foreignId)).toBe(false);
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: snapshot.id } })).toMatchObject({ approvalHash: null });
    const canRead = vi.fn(() => true); // only the SQL defense may refuse this row
    vi.spyOn(history, 'nodeRevisionsScope').mockResolvedValue({ ...realScope!, canRead });
    expect(await plainPinWarnings(reader, { memoryId }, '{{> target rev=1}}')).toEqual([]);
    expect(canRead).toHaveBeenCalledWith(foreignId);
  });
});

it('a platform ADMIN stays restricted and cannot learn a foreign private capture', async () => {
  const { target } = await movedCapture(foreignId);
  const admin = { ...reader, roles: ['ADMIN'] };
  const scope = await history.nodeRevisionsScope(admin, target.id);
  expect(scope?.accessible).not.toBeNull();
  expect(scope?.canRead(foreignId)).toBe(false);
  expect(await history.nodeQueries.nodeRevisions(null, { nodeRef: target.id }, admin)).toEqual([]);
  expect(await plainPinWarnings(admin, { memoryId }, '{{> target rev=1}}')).toEqual([]);
});

it('missing, unreadable, deleted and foreign captures all give the same empty advice', async () => {
  const { target } = await movedCapture(foreignId);
  expect(await plainPinWarnings(reader, { memoryId }, '{{> target rev=1}}')).toEqual([]);
  expect(await plainPinWarnings(reader, { memoryId }, '{{> missing rev=1}}')).toEqual([]);
  expect(await plainPinWarnings(reader, { memoryId }, '{{> target rev=999}}')).toEqual([]);
  await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
  expect(await plainPinWarnings(reader, { memoryId }, '{{> target rev=1}}')).toEqual([]);
});
