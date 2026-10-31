/**
 * #2782 — a calendar, drive or mail operation on a connection the caller cannot use answers ONE typed refusal on the
 * wire, whether the connection is absent, malformed, deleted, another user's, or (for an App) not granted to it. The
 * absent case used to throw a plain Error, which the production formatter redacts to INTERNAL_SERVER_ERROR, so it
 * 500'd and differed from a denial (an existence oracle). Every pin runs through the production `formatGraphQLError`,
 * because the redaction only happens there. cor:api:260:01 (a typed refusal keeps its code).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({})),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { runEmailOperation } from '../../../lib/emailClient.js';
import { formatGraphQLError } from '../formatError.js';
import { driveSearch } from '../../../lib/runner/tools/driveTools.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

/** The wire answer, as a client sees it: the data and each error's message and code. */
async function wire(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  const { data, errors } = res.body.singleResult;
  return { data: data ?? null, errors: (errors ?? []).map((e) => ({ message: e.message, code: e.extensions?.code })) };
}

/** The one refusal every unusable connection answers: the gate's denial (#2782, option A in the dispatch thread). */
const REFUSAL = { data: null, errors: [{ message: 'Forbidden', code: 'FORBIDDEN' }] };

let owner: { id: string };
let other: { id: string };
let appId: string;
const conn: Record<'mail' | 'cal' | 'drive', string> = { mail: '', cal: '', drive: '' };
let othersCal: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  owner = await db.user.create({ data: { id: generateId(), handle: 'cnfowner', githubId: 27821, githubUsername: 'cnfowner', name: 'Owner' } });
  other = await db.user.create({ data: { id: generateId(), handle: 'cnfother', githubId: 27822, githubUsername: 'cnfother', name: 'Other' } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'CNF Org', urn: 'cnf2782.test', createdBy: owner.id } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: owner.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: other.id, role: 'ADMIN' },
  ] });
  const mk = async (userId: string, provider: string, email: string) => (await db.exchangeConnection.create({
    data: { organizationId: org.id, userId, mailboxEmail: email, provider, toolConnectionId: `tool-${provider}-${email}`, createdBy: userId },
  })).id;
  conn.mail = await mk(owner.id, 'ms-exchange', 'owner@mail.example');
  conn.cal = await mk(owner.id, 'google-cal', 'owner@cal.example');
  conn.drive = await mk(owner.id, 'google-drive', 'owner@drive.example');
  othersCal = await mk(other.id, 'google-cal', 'other@cal.example');
  appId = (await db.app.create({ data: { id: generateId(), name: 'CNF', urn: 'cnf2782.test:cnf', organizationId: org.id } })).id;
});

/** Every read surface that runs through `runOwnedEmailOperation`, by family. */
const SURFACES: Array<{ family: 'mail' | 'cal' | 'drive'; name: string; q: (id: string) => string }> = [
  { family: 'mail', name: 'exchangeMessages', q: (id) => `query { exchangeMessages(connectionId: "${id}") { id } }` },
  { family: 'mail', name: 'exchangeFolders', q: (id) => `query { exchangeFolders(connectionId: "${id}") { id } }` },
  { family: 'cal', name: 'calendars', q: (id) => `query { calendars(connectionRef: "${id}") { id } }` },
  { family: 'cal', name: 'calendarEvents', q: (id) => `query { calendarEvents(connectionRef: "${id}") { id } }` },
  { family: 'cal', name: 'calendarEvent', q: (id) => `query { calendarEvent(connectionRef: "${id}", eventId: "e1") { id } }` },
  { family: 'cal', name: 'calendarSchedule', q: (id) => `query { calendarSchedule(connectionRef: "${id}", start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z") { id } }` },
  { family: 'drive', name: 'driveFiles', q: (id) => `query { driveFiles(connectionRef: "${id}") { nextPageToken } }` },
  { family: 'drive', name: 'driveFile', q: (id) => `query { driveFile(connectionRef: "${id}", fileId: "f1") { id } }` },
  { family: 'drive', name: 'driveFileExport', q: (id) => `query { driveFileExport(connectionRef: "${id}", fileId: "f1") { content } }` },
];

describe('#2782 an unusable connection answers one typed refusal on every surface', () => {
  for (const s of SURFACES) {
    it(`${s.name}: malformed, absent and deleted ids answer the typed refusal, never INTERNAL_SERVER_ERROR`, async () => {
      const asOwner = { userId: owner.id, roles: ['READER' as const] };
      expect(await wire(s.q('nonexistent'), asOwner)).toEqual(REFUSAL);
      expect(await wire(s.q(generateId()), asOwner)).toEqual(REFUSAL);
      await db.exchangeConnection.update({ where: { id: conn[s.family] }, data: { deletedAt: new Date() } });
      expect(await wire(s.q(conn[s.family]), asOwner)).toEqual(REFUSAL);
      expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
    });

    it(`${s.name}: another user's connection answers exactly what an absent one does (no existence oracle)`, async () => {
      const asOther = { userId: other.id, roles: ['READER' as const] };
      const absent = await wire(s.q(generateId()), asOther);
      expect(await wire(s.q(conn[s.family]), asOther)).toEqual(absent);
      expect(absent).toEqual(REFUSAL);
    });

    it(`${s.name}: an App with no grant on a real connection answers what it answers for an absent one`, async () => {
      const asApp = { appId, roles: [] };
      expect(await wire(s.q(conn[s.family]), asApp)).toEqual(await wire(s.q(generateId()), asApp));
    });
  }

  it('control: the owner\'s own live connection still runs the operation', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ calendars: [] } as never);
    const r = await wire(`query { calendars(connectionRef: "${conn.cal}") { id } }`, { userId: owner.id, roles: ['READER' as const] });
    expect(r.errors).toEqual([]);
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith('google-cal', expect.any(String), expect.objectContaining({ connectionId: 'tool-google-cal-owner@cal.example' }));
  });

  it('another user\'s calendar is refused like an absent one for its owner\'s org admin too', async () => {
    const asOwner = { userId: owner.id, roles: ['READER' as const] };
    expect(await wire(`query { calendars(connectionRef: "${othersCal}") { id } }`, asOwner))
      .toEqual(await wire(`query { calendars(connectionRef: "${generateId()}") { id } }`, asOwner));
  });
});

describe('#2782 the drive run tool, the one non-GraphQL caller of the gate, refuses alike', () => {
  const refusal = async (connectionRef: string) => {
    const ctx = { log: () => {}, db, run: {} as never, principal: { db, appId, roles: [] } as unknown as Context };
    try {
      await driveSearch.execute(ctx as never, { connectionRef });
    } catch (e) {
      const g = e as { message: string; extensions?: Record<string, unknown> };
      return formatGraphQLError({ message: g.message, extensions: g.extensions }, e);
    }
    throw new Error('expected a refusal');
  };

  it('an absent connection and an ungranted one give the run the same typed refusal', async () => {
    const absent = await refusal(generateId());
    expect(absent).toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    expect(await refusal(conn.drive)).toEqual(absent);
  });
});
