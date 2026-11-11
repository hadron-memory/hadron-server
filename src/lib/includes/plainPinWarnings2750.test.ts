/** #2750: history admission and each redundant moved-capture defense are pinned separately. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { buildNodeRevisionSnapshot } from '../nodeRevisionSnapshot.js';
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

async function movedCapture(captureMemoryId: string | null) {
  const target = await db.node.create({ data: {
    id: generateId(), memoryId, loc: 'target', name: 'Private capture title', content: 'Current body', revSeq: 2,
  } });
  const snapshot = await db.nodeRevision.create({ data: {
    id: generateId(), revNo: 1,
    ...buildNodeRevisionSnapshot({ ...target, content: 'Captured body' }, { userId: reader.userId }),
    memoryId: captureMemoryId,
  } });
  return { target, snapshot };
}

it.each(['current', 'readable foreign', 'null'] as const)(
  'warns a restricted history reader about a plain %s-memory capture', async kind => {
    const captureId = kind === 'current' ? memoryId : kind === 'readable foreign' ? readableForeignId : null;
    const { target, snapshot } = await movedCapture(captureId);
    const scope = await history.nodeRevisionsScope(reader, target.id);
    expect(scope?.accessible).toEqual(expect.any(Array));
    expect(scope?.canRead(captureId ?? memoryId)).toBe(true);
    if (captureId) expect(scope?.accessible).toContain(captureId);
    const revisions = await history.nodeQueries.nodeRevisions(null, { nodeRef: target.id }, reader);
    expect(revisions).toEqual([expect.objectContaining({ id: snapshot.id, memoryId: captureId, content: 'Captured body' })]);
    expect(await plainPinWarnings(reader, { memoryId }, '{{> target rev=1}}')).toEqual(EXPECTED);
  },
);

it('a userless principal has bounded scope and cannot use history advice', async () => {
  const { target } = await movedCapture(foreignId);
  const principal: Context = { db, roles: [] };
  expect(await getAccessibleMemoryIds(principal)).not.toBeNull();
  await expect(history.nodeQueries.nodeRevisions(null, { nodeRef: target.id }, principal)).rejects.toMatchObject({
    extensions: { code: 'FORBIDDEN' },
  });
  expect(await plainPinWarnings(principal, { memoryId }, '{{> target rev=1}}')).toEqual([]);
});

it.each([
  { label: 'missing', roles: undefined },
  { label: 'empty', roles: [] },
])('$label roles stay silent for an existing target', async ({ roles }) => {
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
  it.each(['explicit-list', 'no-filter'] as const)('canRead alone conceals a capture in a %s scope', async kind => {
    const captureId = readableForeignId;
    const { target, snapshot } = await movedCapture(captureId);
    const principal = reader;
    const realScope = await history.nodeRevisionsScope(principal, target.id);
    expect(realScope).not.toBeNull();
    expect(realScope!.canRead(captureId)).toBe(true);
    expect(realScope!.accessible).toContain(captureId);
    expect(await db.nodeRevision.findUniqueOrThrow({ where: { id: snapshot.id } })).toMatchObject({ approvalHash: null });
    const canRead = vi.fn((id: string) => id !== captureId);
    const scope = vi.spyOn(history, 'nodeRevisionsScope').mockResolvedValue({ ...realScope!, accessible: kind === 'no-filter' ? null : realScope!.accessible, canRead });
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
  const admin: Context = { ...reader, roles: ['ADMIN'] };
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
