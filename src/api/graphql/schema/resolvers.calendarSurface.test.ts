/**
 * Calendar surface over hadrontool-google-cal.
 *
 * What this file pins:
 *   - Calendar ops ride the SAME gate as mail (requireEmailConnection):
 *     interactive owner allowed, other org members / platform admins denied,
 *     App principals fail-closed without a covering ConnectionGrant.
 *   - Grant scoping: calendar.read covers the read queries, calendar.freebusy
 *     covers ONLY calendarSchedule, and calendar MUTATIONS have no scope —
 *     owner-only, denied for Apps even with grants.
 *   - Ops route through emailClient with provider 'google-cal' and the
 *     TOOL's connection id, never core's row id.
 *   - The wire→schema response mapping (lowercase tool vocabulary →
 *     CalendarEventResponse enum) on both query and mutation surfaces.
 *
 * The provider tool is mocked at the emailClient seam — these tests cover
 * core's gate + routing, not the tool (it has its own 51-test suite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({ events: [] })),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { runEmailOperation } from '../../../lib/emailClient.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

/** A tool-shaped calendar event (wire form: lowercase response vocabulary). */
function toolEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    calendarId: 'primary',
    title: 'Mentoring session',
    description: null,
    location: null,
    start: { dateTime: '2026-07-15T10:00:00-07:00', date: null, timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-07-15T10:30:00-07:00', date: null, timeZone: 'America/Los_Angeles' },
    isAllDay: false,
    status: 'confirmed',
    organizer: { name: 'The Mentor', address: 'mentor@example.org' },
    isOrganizer: false,
    attendees: [{ name: 'The Mentor', address: 'mentor@example.org', optional: false, response: 'accepted' }],
    myResponse: 'none',
    webLink: 'https://calendar.google.com/event?eid=abc',
    seriesId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

let owner: { id: string };
let orgAdmin: { id: string };
let orgId: string;
let connectionId: string;
let appId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  owner = await db.user.create({
    data: { id: generateId(), handle: 'calowner', githubId: 9201, githubUsername: 'calowner', name: 'Owner' },
  });
  orgAdmin = await db.user.create({
    data: { id: generateId(), handle: 'caladmin', githubId: 9202, githubUsername: 'caladmin', name: 'Admin' },
  });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Cal Org', urn: 'calorg.test', createdBy: owner.id },
  });
  orgId = org.id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: owner.id, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: orgAdmin.id, role: 'ADMIN' },
    ],
  });
  const connection = await db.exchangeConnection.create({
    data: {
      organizationId: orgId,
      userId: owner.id,
      mailboxEmail: 'owner@gcal.example',
      provider: 'google-cal',
      toolConnectionId: 'tool-cal-1',
      createdBy: owner.id,
    },
  });
  connectionId = connection.id;
  const app = await db.app.create({
    data: { id: generateId(), name: 'CalApp', urn: 'calorg.test:calapp', organizationId: orgId },
  });
  appId = app.id;
});

/** Grant the fixture App the given scopes on the fixture connection. */
async function grantApp(scopes: string[]) {
  await db.connectionGrant.create({
    data: {
      id: generateId(),
      connectionId,
      granteeAppId: appId,
      grantedByUserId: owner.id,
      scopes,
    },
  });
}

const EVENTS_QUERY = (id: string) => `query { calendarEvents(connectionRef: "${id}") { id title myResponse attendees { address response } } }`;

describe('calendar reads route through the tool with the google-cal provider', () => {
  it('lets the owner list events, mapping the response vocabulary to the enum', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ events: [toolEvent()] });
    const r = await run(EVENTS_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.calendarEvents).toEqual([
      {
        id: 'evt-1',
        title: 'Mentoring session',
        myResponse: 'NONE',
        attendees: [{ address: 'mentor@example.org', response: 'ACCEPTED' }],
      },
    ]);
    // Routed with the TOOL's connection id + the row's provider, top clamped
    // to the default.
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-cal',
      'list-events',
      expect.objectContaining({ connectionId: 'tool-cal-1', top: 20 }),
    );
  });

  it('clamps top to the tool cap and forwards the window args', async () => {
    await run(
      `query { calendarEvents(connectionRef: "${connectionId}", start: "2026-07-14T00:00:00Z", end: "2026-07-21T00:00:00Z", top: 500) { id } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-cal',
      'list-events',
      expect.objectContaining({ start: '2026-07-14T00:00:00Z', end: '2026-07-21T00:00:00Z', top: 100 }),
    );
  });

  it('lists calendars and queries free/busy schedules', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      calendars: [{ id: 'primary', name: 'Owner', description: null, timeZone: 'UTC', isPrimary: true, canEdit: true }],
    });
    const cals = await run(`query { calendars(connectionRef: "${connectionId}") { id isPrimary canEdit } }`, {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(cals.errors).toBeUndefined();
    expect(cals.data?.calendars).toEqual([{ id: 'primary', isPrimary: true, canEdit: true }]);

    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      schedules: [{ id: 'primary', busy: [{ start: '2026-07-15T10:00:00Z', end: '2026-07-15T10:30:00Z' }], error: null }],
    });
    const fb = await run(
      `query { calendarSchedule(connectionRef: "${connectionId}", start: "2026-07-15T00:00:00Z", end: "2026-07-16T00:00:00Z") { id busy { start end } error } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(fb.errors).toBeUndefined();
    expect(fb.data?.calendarSchedule).toEqual([
      { id: 'primary', busy: [{ start: '2026-07-15T10:00:00Z', end: '2026-07-15T10:30:00Z' }], error: null },
    ]);
    expect(vi.mocked(runEmailOperation)).toHaveBeenLastCalledWith(
      'google-cal',
      'get-schedule',
      expect.objectContaining({ start: '2026-07-15T00:00:00Z', end: '2026-07-16T00:00:00Z' }),
    );
  });
});

describe('the shared connection gate applies to calendar ops', () => {
  it('denies another org member — even an org ADMIN', async () => {
    const r = await run(EVENTS_QUERY(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('denies a platform ADMIN who is not the owner (no admin bypass)', async () => {
    const r = await run(EVENTS_QUERY(connectionId), { userId: orgAdmin.id, roles: ['ADMIN'] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
  });

  it('denies an App principal without a grant (fail-closed)', async () => {
    const r = await run(EVENTS_QUERY(connectionId), { appId, roles: [] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('lets an App with calendar.read list events — but not query free/busy', async () => {
    await grantApp(['calendar.read']);
    const events = await run(EVENTS_QUERY(connectionId), { appId, roles: [] });
    expect(events.errors).toBeUndefined();

    const fb = await run(
      `query { calendarSchedule(connectionRef: "${connectionId}", start: "a", end: "b") { id } }`,
      { appId, roles: [] },
    );
    expect(fb.errors?.[0]?.message).toBe('Forbidden');
  });

  it('caps an App with only calendar.freebusy at the schedule query — never event contents', async () => {
    await grantApp(['calendar.freebusy']);
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ schedules: [] });
    const fb = await run(
      `query { calendarSchedule(connectionRef: "${connectionId}", start: "a", end: "b") { id } }`,
      { appId, roles: [] },
    );
    expect(fb.errors).toBeUndefined();

    const events = await run(EVENTS_QUERY(connectionId), { appId, roles: [] });
    expect(events.errors?.[0]?.message).toBe('Forbidden');
  });

  it('keeps calendar mutations owner-only — an App is denied even with every calendar grant', async () => {
    await grantApp(['calendar.read', 'calendar.freebusy']);
    const r = await run(
      `mutation { calendarDeleteEvent(connectionRef: "${connectionId}", eventId: "evt-1") }`,
      { appId, roles: [] },
    );
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('reports a soft-deleted connection as not found', async () => {
    await db.exchangeConnection.update({ where: { id: connectionId }, data: { deletedAt: new Date() } });
    const r = await run(EVENTS_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors?.[0]?.message).toBe('Connection not found');
  });
});

describe('a calendar connection coexists with a mail connection for the same account', () => {
  // PR-638 Codex P1: the ExchangeConnection uniqueness key is
  // provider-scoped — connecting Google Calendar for an address that already
  // has a Gmail connection must create a SECOND row, never upsert over the
  // mail row (which would tear down its tool connection and grants).
  it('allows both rows under the provider-scoped unique key, each routing to its own provider', async () => {
    const mailConnection = await db.exchangeConnection.create({
      data: {
        organizationId: orgId,
        userId: owner.id,
        mailboxEmail: 'owner@gcal.example', // SAME address as the calendar fixture
        provider: 'gmail',
        toolConnectionId: 'tool-mail-1',
        createdBy: owner.id,
      },
    });

    await run(`query { exchangeMessages(connectionId: "${mailConnection.id}") { id } }`, {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(vi.mocked(runEmailOperation)).toHaveBeenLastCalledWith(
      'gmail',
      'list-messages',
      expect.objectContaining({ connectionId: 'tool-mail-1' }),
    );

    vi.mocked(runEmailOperation).mockResolvedValueOnce({ events: [] });
    await run(EVENTS_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(vi.mocked(runEmailOperation)).toHaveBeenLastCalledWith(
      'google-cal',
      'list-events',
      expect.objectContaining({ connectionId: 'tool-cal-1' }),
    );
  });
});

describe('calendar mutations', () => {
  it('calendarCreateEvent routes create-event with the idempotency key and returns the mapped event', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      event: toolEvent({ id: 'evt-new', myResponse: null, attendees: [] }),
    });
    const r = await run(
      `mutation { calendarCreateEvent(
        connectionRef: "${connectionId}",
        title: "Standup",
        start: { dateTime: "2026-07-20T09:00:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-07-20T09:15:00", timeZone: "America/Los_Angeles" },
        attendees: ["peer@example.org"],
        notifyAttendees: false,
        idempotencyKey: "k-1"
      ) { id myResponse } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.calendarCreateEvent).toEqual({ id: 'evt-new', myResponse: null });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-cal',
      'create-event',
      expect.objectContaining({
        connectionId: 'tool-cal-1',
        title: 'Standup',
        // Explicit GraphQL nulls are stripped — the tool's either/or boundary
        // schema must see absent fields.
        start: { dateTime: '2026-07-20T09:00:00', date: undefined, timeZone: 'America/Los_Angeles' },
        attendees: ['peer@example.org'],
        notifyAttendees: false,
        idempotencyKey: 'k-1',
      }),
    );
  });

  it('rejects NONE as a settable response in core with a stable code', async () => {
    const r = await run(
      `mutation { calendarRespondToEvent(connectionRef: "${connectionId}", eventId: "evt-1", response: NONE) { id } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(r.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('calendarRespondToEvent maps the enum to the neutral vocabulary', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      event: toolEvent({ myResponse: 'accepted' }),
    });
    const r = await run(
      `mutation { calendarRespondToEvent(connectionRef: "${connectionId}", eventId: "evt-1", response: ACCEPTED) { id myResponse } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.calendarRespondToEvent).toEqual({ id: 'evt-1', myResponse: 'ACCEPTED' });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-cal',
      'respond-to-event',
      expect.objectContaining({ eventId: 'evt-1', response: 'accepted' }),
    );
  });
});
