/**
 * #3933 — agentTeamEvents can be read from the NEWEST end (the portal's alarm view walked forward and could not reach alarms
 * past 2000 events). Vera's FIT conditions: (a) no direction => today's rows and order, byte-identical; (b) the same gate and the
 * same filters in both directions; (c) a default page of 20, a cap of 200 that serves a capped page and never refuses, and an
 * older-cursor so the reader can tell whether older rows remain; (d) the exact mirror of today's (createdAt, id) order, so a page
 * boundary inside equal timestamps neither repeats nor skips.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const T0 = Date.UTC(2026, 10, 1);

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  return undefined;
}

let member: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let keyId: string;
const user = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const key = (): Context => ({ db, appId: app.id, appKeyId: keyId, roles: [] });
type Row = { id: string; createdAt: Date };
const ids = (rows: Row[]) => rows.map((r) => r.id);

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'ev-org', urn: `ev-org-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_300, githubUsername: `ev-${suffix}`, roles: ['READER'] }, select: { id: true } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 98_301, githubUsername: `evo-${suffix}`, roles: ['READER'] }, select: { id: true } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  keyId = (await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } })).id;
});

/** `n` events, one every second, except that every third pair SHARES a timestamp, so (createdAt, id) is the only total order. */
async function seed(appId: string, n: number, extra: Partial<{ type: string; severity: string | null }> = {}): Promise<Row[]> {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: generateId(),
    appId,
    type: extra.type ?? 'task.created',
    severity: extra.severity ?? null,
    createdAt: new Date(T0 + Math.floor(i / 2) * 1000),
  }));
  await db.agentTeamEvent.createMany({ data: rows });
  // the default read's order, (createdAt, id): ids are random, so ties sort by id, not by creation index
  return rows.map(({ id, createdAt }) => ({ id, createdAt })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

describe('agentTeamEvents newest-first (#3933)', () => {
  it('(a) the default read is oldest-first and unchanged, 20 per page', async () => {
    const all = await seed(app.id, 30);
    const page = await Q.agentTeamEvents({}, { appRef: app.id }, user());
    expect(ids(page)).toEqual(ids(all).slice(0, 20));
  });

  it('(d) newestFirst is the exact mirror of the default order, 20 by default', async () => {
    const all = await seed(app.id, 30);
    const page = await Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true }, user());
    expect(ids(page)).toEqual(ids(all).slice().reverse().slice(0, 20));
  });

  it('(d) paging with before walks every event once, across equal timestamps, with no repeat or skip', async () => {
    const all = await seed(app.id, 45);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page: Row[] = await Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true, limit: 7, ...(before ? { before } : {}) }, user());
      if (page.length === 0) break;
      seen.push(...ids(page));
      before = page[page.length - 1]!.id;
    }
    expect(seen).toEqual(ids(all).slice().reverse());
  });

  it('(c) the cap serves a capped page, never a refusal, and an older page is reachable past it', async () => {
    const all = await seed(app.id, 230);
    const page = await Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true, limit: 5000 }, user());
    expect(ids(page)).toEqual(ids(all).slice().reverse().slice(0, 200));
    const older = await Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true, limit: 5000, before: page[199].id }, user());
    expect(ids(older)).toEqual(ids(all).slice().reverse().slice(200));
  });

  it('(b) the same filters apply in both directions', async () => {
    const plain = await seed(app.id, 6);
    const alarms = await db.agentTeamEvent.createManyAndReturn({
      data: [3, 4].map((i) => ({ id: generateId(), appId: app.id, type: 'stall.no-progress', severity: 'alarm', createdAt: new Date(T0 + i * 1000 + 500) })),
      select: { id: true, createdAt: true },
    });
    const fwd = await Q.agentTeamEvents({}, { appRef: app.id, alarmsOnly: true }, user());
    const back = await Q.agentTeamEvents({}, { appRef: app.id, alarmsOnly: true, newestFirst: true }, user());
    expect(ids(fwd).sort()).toEqual(ids(alarms).sort());
    expect(ids(back)).toEqual(ids(fwd).slice().reverse());
    const typed = await Q.agentTeamEvents({}, { appRef: app.id, types: ['task.created'], newestFirst: true }, user());
    expect(ids(typed)).toEqual(ids(plain).slice().reverse());
  });

  it('(b) the same gate in both directions: an outsider and another App\'s key are refused like a missing App, a key reads its own', async () => {
    await seed(app.id, 3);
    for (const newestFirst of [false, true]) {
      expect(await code(Q.agentTeamEvents({}, { appRef: app.id, newestFirst }, { db, userId: outsider.id, roles: ['READER'] }))).toBe('APP_NOT_FOUND');
      expect(await code(Q.agentTeamEvents({}, { appRef: otherApp.id, newestFirst }, key()))).toBe('APP_NOT_FOUND');
      expect(ids(await Q.agentTeamEvents({}, { appRef: app.id, newestFirst }, key())).length).toBe(3);
    }
  });

  it('before is an event of THIS App only, and only with newestFirst; after is refused with newestFirst', async () => {
    const mine = await seed(app.id, 3);
    const theirs = await seed(otherApp.id, 2);
    expect(await code(Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true, before: theirs[0]!.id }, user()))).toBe('BAD_USER_INPUT');
    expect(await code(Q.agentTeamEvents({}, { appRef: app.id, before: mine[2]!.id }, user()))).toBe('BAD_USER_INPUT');
    expect(await code(Q.agentTeamEvents({}, { appRef: app.id, newestFirst: true, after: mine[0]!.id }, user()))).toBe('BAD_USER_INPUT');
  });
});
