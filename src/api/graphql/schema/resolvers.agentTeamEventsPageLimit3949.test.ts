/**
 * #3949 (cor:api:120:04, cor:agt:050:11): agentTeamEventsPage(limit: 0) read one lookahead row yet served none, so an existing
 * event gave events: [], hasMore: true, nextCursor: null - a continuation the caller could not follow. The decided contract
 * (Victor's FIT): the Page field's size has a floor of 1 (0 or less reads one); hasMore: true always carries a non-null
 * nextCursor. Pagination only: no gate or filter change; the legacy agentTeamEvents(limit: 0) list stays [].
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

describe('agentTeamEventsPage limit floor (#3949)', () => {
  type Page = { events: Row[]; hasMore: boolean; nextCursor: string | null };
  const page = (args: Record<string, unknown>): Promise<Page> => Q.agentTeamEventsPage({}, { appRef: app.id, ...args }, user());

  it.each([0, -1, -50])('(1)(2) limit %i reads one event oldest-first and continues with after', async (limit) => {
    const all = await seed(app.id, 4);
    const p = await page({ limit });
    expect(ids(p.events)).toEqual([all[0]!.id]);
    expect(p.hasMore).toBe(true);
    expect(p.nextCursor).toBe(all[0]!.id);
    const next = await page({ limit, after: p.nextCursor });
    expect(ids(next.events)).toEqual([all[1]!.id]);
  });

  it('(1) limit 0 with newestFirst reads the newest one and continues with before', async () => {
    const all = await seed(app.id, 4);
    const p = await page({ limit: 0, newestFirst: true });
    expect(ids(p.events)).toEqual([all[3]!.id]);
    expect(p.hasMore).toBe(true);
    expect(p.nextCursor).toBe(all[3]!.id);
    const next = await page({ limit: 0, newestFirst: true, before: p.nextCursor });
    expect(ids(next.events)).toEqual([all[2]!.id]);
  });

  it('(1) limit 0 on the last event: hasMore false, nextCursor null', async () => {
    const all = await seed(app.id, 1);
    const p = await page({ limit: 0 });
    expect(ids(p.events)).toEqual([all[0]!.id]);
    expect(p.hasMore).toBe(false);
    expect(p.nextCursor).toBeNull();
  });

  it('(1) walking by limit 0 visits every event once in both directions', async () => {
    const all = await seed(app.id, 5);
    for (const newestFirst of [false, true]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const p: Page = await page({ limit: 0, newestFirst, ...(cursor ? (newestFirst ? { before: cursor } : { after: cursor }) : {}) });
        seen.push(...ids(p.events));
        if (!p.hasMore) break;
        cursor = p.nextCursor;
      }
      expect(seen).toEqual(newestFirst ? ids(all).slice().reverse() : ids(all));
    }
  });

  it('(3) an empty stream, and an after past the end, give an empty page - not an error', async () => {
    for (const newestFirst of [false, true]) {
      expect(await page({ limit: 0, newestFirst })).toEqual({ events: [], hasMore: false, nextCursor: null });
    }
    const all = await seed(app.id, 2);
    expect(await page({ limit: 0, after: all[1]!.id })).toEqual({ events: [], hasMore: false, nextCursor: null });
    expect(await page({ limit: 0, newestFirst: true, before: all[0]!.id })).toEqual({ events: [], hasMore: false, nextCursor: null });
  });

  it('(4) hasMore true never comes with a null nextCursor, across page sizes', async () => {
    await seed(app.id, 3);
    for (const limit of [-1, 0, 1, 2, 3, 4, 20, null, undefined]) {
      for (const newestFirst of [false, true]) {
        const p = await page({ limit, newestFirst });
        if (p.hasMore) expect(p.nextCursor).not.toBeNull();
        else expect(p.nextCursor).toBeNull();
      }
    }
  });

  it('(5) the legacy agentTeamEvents(limit: 0) still returns []', async () => {
    await seed(app.id, 3);
    expect(await Q.agentTeamEvents({}, { appRef: app.id, limit: 0 }, user())).toEqual([]);
    expect(await Q.agentTeamEvents({}, { appRef: app.id, limit: 0, newestFirst: true }, user())).toEqual([]);
  });

  it('the gate is unchanged: an outsider is refused APP_NOT_FOUND at limit 0', async () => {
    await seed(app.id, 1);
    expect(await code(Q.agentTeamEventsPage({}, { appRef: app.id, limit: 0 }, { db, userId: outsider.id, roles: ['READER'] }))).toBe('APP_NOT_FOUND');
  });
});
