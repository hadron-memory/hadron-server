/**
 * importNode target refusals (hadron-internal#72).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/webFetch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWebPage: vi.fn(async (url: string) => ({ html: '<p>page</p>', finalUrl: url })),
}));

import { fetchWebPage } from '../../../lib/webFetch.js';

const HIDDEN = 'ref72-theirs:hidden';
const ABSENT = 'ref72-theirs:absent';

let hiddenId: string;
let readerId: string;
let writerId: string;
let outsiderId: string;
let otherOrgId: string;
let foreignAppId: string;

const userCtx = (userId: string): Context => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` });

/** The answer is named per caller, so two identical but wrong answers cannot pass. */
const notFound = { name: 'MemoryNotFoundError', ref: '<ref>' };

const callers: ReadonlyArray<readonly [string, () => Context, Record<string, unknown>]> = [
  ['a user in no organization', () => userCtx(outsiderId), notFound],
  ["another organization's admin", () => userCtx(otherOrgId), notFound],
  ["another organization's App key", () => ({ db, appId: foreignAppId, roles: [], clientId: `app:${foreignAppId}` }), notFound],
  ['a signed-out caller', () => ({ db, roles: [], clientId: 'anonymous' }), { extensions: { code: 'UNAUTHENTICATED' } }],
];

const body = { content: '# x', contentType: 'text/markdown', name: 'x' };

/** One target per spelling the door accepts: [label, input for the hidden memory, input for a missing one]. */
const targets: ReadonlyArray<readonly [string, () => [Record<string, string>, string], () => [Record<string, string>, string]]> = [
  [
    'memoryRef as an id',
    () => [{ memoryRef: hiddenId, loc: 'clips:x' }, hiddenId],
    () => { const id = generateId(); return [{ memoryRef: id, loc: 'clips:x' }, id]; },
  ],
  [
    'memoryRef as a URN',
    () => [{ memoryRef: `hrn:mem:${HIDDEN}`, loc: 'clips:x' }, `hrn:mem:${HIDDEN}`],
    () => [{ memoryRef: `hrn:mem:${ABSENT}`, loc: 'clips:x' }, `hrn:mem:${ABSENT}`],
  ],
  [
    'nodeUrn',
    () => [{ nodeUrn: `hrn:node:${HIDDEN}:clips:x` }, HIDDEN],
    () => [{ nodeUrn: `hrn:node:${ABSENT}:clips:x` }, ABSENT],
  ],
];

async function refusal(input: Record<string, unknown>, ctx: Context, sentRef: string) {
  const error = await resolvers.Mutation.importNode({}, { input: input as never }, ctx).then(
    () => { throw new Error('importNode was expected to refuse'); },
    (e: unknown) => e as Error & { ref?: string; extensions?: Record<string, unknown> },
  );
  const normalise = (text: string) => text.split(sentRef).join('<ref>');
  return {
    name: error.name,
    message: error.message,
    ref: error.ref === undefined ? undefined : normalise(error.ref),
    extensions: JSON.parse(normalise(JSON.stringify(error.extensions ?? null))) as unknown,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const theirs = await db.organization.create({ data: { id: generateId(), name: 'ref72-theirs', urn: 'ref72-theirs' } });
  const mine = await db.organization.create({ data: { id: generateId(), name: 'ref72-mine', urn: 'ref72-mine' } });
  const user = async (name: string) => (await db.user.create({ data: { id: generateId(), name, roles: ['READER'] } })).id;
  readerId = await user('reader');
  writerId = await user('writer');
  outsiderId = await user('outsider');
  otherOrgId = await user('other-admin');
  await db.orgMember.create({ data: { organizationId: theirs.id, userId: readerId, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: theirs.id, userId: writerId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: mine.id, userId: otherOrgId, role: 'ADMIN' } });
  hiddenId = (await db.memory.create({ data: {
    id: generateId(), name: 'hidden', urn: HIDDEN, class: 'knowledge', organizationId: theirs.id,
  } })).id;
  const agent = await db.agent.create({ data: { name: 'Elsewhere', urn: 'ref72-mine:agent', organizationId: mine.id } });
  foreignAppId = (await db.app.create({ data: { name: 'Elsewhere', urn: 'ref72-mine:app', organizationId: mine.id } })).id;
  await db.appAgent.create({ data: { appId: foreignAppId, agentId: agent.id } });
});

describe('importNode target refusals', () => {
  describe.each(callers)('%s', (_caller, ctx, expected) => {
    it.each(targets)('refuses (%s)', async (_target, hidden, absent) => {
      const [hiddenInput, hiddenRef] = hidden();
      const [absentInput, absentRef] = absent();
      const missing = await refusal({ ...absentInput, ...body }, ctx(), absentRef);
      const present = await refusal({ ...hiddenInput, ...body }, ctx(), hiddenRef);
      expect(present).toEqual(missing);
      expect(present).toMatchObject(expected);
      expect(await db.node.count({ where: { memoryId: hiddenId, loc: 'clips:x' } })).toBe(0);
    });
  });

  it('refuses an outsider before any fetch', async () => {
    const ref = `hrn:mem:${HIDDEN}`;
    await expect(resolvers.Mutation.importNode(
      {}, { input: { memoryRef: ref, loc: 'clips:x', url: 'https://example.com/a' } as never }, userCtx(outsiderId),
    )).rejects.toMatchObject({ name: 'MemoryNotFoundError', ref });
    expect(fetchWebPage).not.toHaveBeenCalled();
    expect(await db.appRun.count()).toBe(0);
  });

  it('refuses a reader', async () => {
    await expect(resolvers.Mutation.importNode(
      {}, { input: { memoryRef: hiddenId, loc: 'clips:x', url: 'https://example.com/a' } as never }, userCtx(readerId),
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(fetchWebPage).not.toHaveBeenCalled();
  });

  it('imports for a writer', async () => {
    const result = await resolvers.Mutation.importNode(
      {}, { input: { memoryRef: `hrn:mem:${HIDDEN}`, loc: 'clips:x', ...body } as never }, userCtx(writerId),
    );
    expect(result.status).toBe('STORED');
  });
});
