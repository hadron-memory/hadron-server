/**
 * #2177 — Agent.extendedBy: who may see which extender, how pages continue, and that the
 * continuation token reveals nothing about a row the caller cannot read.
 *
 * The anchor is PARITY: for every audience the field lists exactly the children `Query.agent`
 * answers for that audience. Everything else pins one way that could drift from it: the page cap
 * before visibility, a token that names a hidden row, a token replayed by someone else.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import {
  EXTENDED_BY_CURSOR_MAX_LENGTH, EXTENDED_BY_CURSOR_VERSION, extendedByAudience, openExtendedByCursor,
  InvalidExtendedByCursorError, sealExtendedByCursor,
} from '../../../lib/agentExtendedByCursor.js';
import { EXTENDED_BY_SCAN_CAP } from './resolvers.agentExtendedBy.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const A = resolvers.Agent as any;
const Q = resolvers.Query as any;

const SENTINEL_NAME = 'ZZ-SENTINEL-NAME-x7q9';
const SENTINEL_ID = 'c0dec0dec0dec0dec0dec0dec0de1234';

const asUser = (userId: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });
const asAnon = (): Context => ({ db, roles: ['READER'] });

type Page = { items: Array<{ id: string }>; hasMore: boolean; endCursor: string | null };
const page = (parent: { id: string }, args: { first?: number; after?: string | null }, c: Context): Promise<Page> =>
  A.extendedBy(parent, args, c);
const ids = (p: Page) => p.items.map((i) => i.id);

async function code(p: Promise<unknown>): Promise<string | undefined> {
  const e = await p.then(() => null, (x: { extensions?: { code?: string } }) => x);
  expect(e, 'expected a refusal').not.toBeNull();
  return e!.extensions?.code;
}

/** A pure App key: the checked path, where an uninstalled private Agent is unreadable. */
async function appCtx(): Promise<Context> {
  const { app } = await createDbAppWithKey(db, `eb-app-${Math.random()}`, orgA.id);
  return { db, appId: app.id, roles: ['READER'] };
}

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let memberA: string; let memberB: string; let stranger: string; let admin: string; let other: string;
let parent: { id: string; urn: string };
let n: number;
const kids: Record<string, string> = {};

async function child(slug: string, data: Record<string, unknown>) {
  const a = await db.agent.create({
    data: { id: generateId(), urn: `${slug}-${n}.example:${slug}`, name: slug, extendsAgentId: parent.id, ...data } as never,
  });
  kids[slug] = a.id;
  return a;
}
async function user(h: string, roles: ('READER' | 'ADMIN')[] = ['READER']) {
  return (await db.user.create({ data: { id: generateId(), name: h, handle: `${h}-${n}`, roles } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1e6);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'A', urn: `eb-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'B', urn: `eb-b-${n}.example` }, select: { id: true, urn: true } });
  memberA = await user('ma'); memberB = await user('mb'); stranger = await user('st'); other = await user('ot');
  admin = await user('ad', ['ADMIN']);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: memberA, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: memberB, role: 'READER' } });
  parent = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:base`, name: 'base', visibility: 'PUBLIC' }, select: { id: true, urn: true } });
  await child('aaa-public-b', { organizationId: orgB.id, visibility: 'PUBLIC' });
  await child('bbb-org-a', { organizationId: orgA.id, visibility: 'ORGANIZATION' });
  await child('ccc-personal-other', { ownerUserId: other, visibility: 'PERSONAL' });
  await db.agent.create({
    data: { id: SENTINEL_ID, urn: `${orgB.urn}:hidden`, name: SENTINEL_NAME, extendsAgentId: parent.id, organizationId: orgB.id, visibility: 'ORGANIZATION' },
  });
  kids.hidden = SENTINEL_ID;
  await child('eee-deleted', { organizationId: orgA.id, visibility: 'PUBLIC', deletedAt: new Date() });
});

/** The children Query.agent answers for this audience: the parity oracle. */
async function readableByQueryAgent(c: Context): Promise<string[]> {
  const out: string[] = [];
  for (const id of Object.values(kids)) {
    if (await Q.agent({}, { ref: id }, c)) out.push(id);
  }
  return out.sort();
}

async function drain(c: Context, first = 2): Promise<{ all: string[]; pages: Page[] }> {
  const pages: Page[] = [];
  let after: string | null = null;
  for (let i = 0; i < 40; i++) {
    const p = await page(parent, { first, after }, c);
    pages.push(p);
    if (!p.hasMore) break;
    after = p.endCursor;
  }
  return { all: pages.flatMap(ids), pages };
}

describe('Agent.extendedBy: visibility is the agent(ref:) gate', () => {
  it.each([
    ['member of org A', () => asUser(memberA)],
    ['member of org B', () => asUser(memberB)],
    ['signed-in stranger', () => asUser(stranger)],
    ['anonymous', () => asAnon()],
    ['the other user (owner of a personal child)', () => asUser(other)],
    ['platform admin', () => asUser(admin, ['ADMIN'])],
  ])('%s sees exactly the children Query.agent answers for', async (_l, mk) => {
    const c = mk();
    const { all } = await drain(c);
    expect([...all].sort()).toEqual(await readableByQueryAgent(c));
  });

  it('a pure App key sees public and INSTALLED children, never an uninstalled private one', async () => {
    // Deliberately not Query.agent parity: a pure App key has the live installed-Agent exception (#1787),
    // which the nested read gate (readableNestedAgent) applies and Query.agent does not.
    const { app } = await createDbAppWithKey(db, 'eb-app', orgA.id);
    await createDbAppAgent(db, app.id, kids['bbb-org-a']);
    const { all } = await drain({ db, appId: app.id, roles: ['READER'] });
    expect([...all].sort()).toEqual([kids['aaa-public-b'], kids['bbb-org-a']].sort());
    expect(all).not.toContain(SENTINEL_ID);
  });

  it('a soft-deleted child is never listed, and the hidden sentinel is absent for a member', async () => {
    const { all } = await drain(asUser(memberA));
    expect(all).not.toContain(kids['eee-deleted']);
    expect(all).not.toContain(SENTINEL_ID);
  });

  it('only DIRECT extenders are listed', async () => {
    const mid = await db.agent.findUniqueOrThrow({ where: { id: kids['bbb-org-a'] } });
    await db.agent.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:grand`, name: 'grand', extendsAgentId: mid.id, visibility: 'PUBLIC' },
    });
    expect((await drain(asUser(memberA))).all).not.toContain((await db.agent.findFirstOrThrow({ where: { name: 'grand' } })).id);
  });

  it('no extension is an empty, complete page; no total exists in the SDL', async () => {
    const lonely = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:lonely`, name: 'lonely', visibility: 'PUBLIC' } });
    expect(await page(lonely, {}, asUser(memberA))).toEqual({ items: [], hasMore: false, endCursor: null });
    const sdl = typeDefs;
    expect(sdl).toMatch(/type AgentExtensionPage \{[^}]*hasMore: Boolean!/);
    expect(sdl.match(/type AgentExtensionPage \{[^}]*\}/)![0]).not.toMatch(/total/i);
  });
});

describe('Agent.extendedBy: paging', () => {
  it('first is bounded 1..50 and defaults to 20', async () => {
    for (const first of [0, -1, 51, 1.5]) {
      expect(await code(page(parent, { first }, asUser(memberA)))).toBe('BAD_USER_INPUT');
    }
    const many = 25;
    for (let i = 0; i < many; i++) await child(`pg-${String(i).padStart(2, '0')}`, { organizationId: orgA.id, visibility: 'PUBLIC' });
    expect((await page(parent, {}, asUser(memberA))).items).toHaveLength(20);
  });

  it('visibility comes BEFORE the cap: hidden rows interleaved with readable ones never shorten a page', async () => {
    for (let i = 0; i < 6; i++) {
      await child(`k-${i}-vis`, { organizationId: orgA.id, visibility: 'PUBLIC' });
      await db.agent.create({ data: { id: generateId(), urn: `${orgB.urn}:k${i}`, name: `k-${i}-aaa-hidden`, extendsAgentId: parent.id, organizationId: orgB.id, visibility: 'ORGANIZATION' } });
    }
    const p1 = await page(parent, { first: 4 }, asUser(memberA));
    expect(p1.items).toHaveLength(4);
    const { all } = await drain(asUser(memberA), 4);
    expect(new Set(all).size).toBe(all.length); // no repeats across pages
    expect([...all].sort()).toEqual(await readableByQueryAgent(asUser(memberA)));
  });

  it('continues deterministically and reports hasMore honestly on both audiences', async () => {
    for (let i = 0; i < 7; i++) await child(`d-${i}`, { organizationId: orgA.id, visibility: 'PUBLIC' });
    for (const c of [asUser(memberA), asUser(admin, ['ADMIN'])]) {
      const first = await drain(c, 3);
      const again = await drain(c, 3);
      expect(first.all).toEqual(again.all);
      expect(first.pages.at(-1)!.hasMore).toBe(false);
      expect(first.pages.at(-1)!.endCursor).toBeNull();
      expect(first.pages.slice(0, -1).every((p) => p.hasMore && p.endCursor)).toBe(true);
    }
  });

  it('a long run of unreadable rows ends in an empty page with hasMore, then progresses (checked path)', async () => {
    // Private org agents that are neither PUBLIC nor installed are unreadable to a pure App key: a hidden run.
    const rows = Array.from({ length: EXTENDED_BY_SCAN_CAP + 20 }, (_, i) => ({
      id: generateId(), urn: `u${n}-${i}.example:p`, name: `00-${String(i).padStart(4, '0')}`,
      extendsAgentId: parent.id, organizationId: orgB.id, visibility: 'ORGANIZATION' as const,
    }));
    await db.agent.createMany({ data: rows as never });
    const c = await appCtx();
    const p1 = await page(parent, { first: 3 }, c);
    expect(p1.items).toEqual([]);
    expect(p1.hasMore).toBe(true);
    expect(p1.endCursor).toBeTruthy();
    const { all } = await drain(c, 3);
    expect(all).toEqual([kids['aaa-public-b']]); // the only readable child: PUBLIC, found past the hidden run
  }, 60_000);
});

const appCtxHolder = { c: undefined as unknown as Context };

describe('Agent.extendedBy: the continuation reveals nothing about hidden rows', () => {
  beforeEach(async () => { appCtxHolder.c = await appCtx(); });

  const encodings = (s: string) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex')];

  it.each([
    ['ordinary caller', () => asUser(memberA)],
    ['checked path (pure App key)', () => appCtxHolder.c],
  ])('no sentinel name or id appears at any output field, %s', async (_l, mk) => {
    const c = mk();
    const { pages } = await drain(c, 1);
    for (const p of pages) {
      const wire = JSON.stringify(p);
      for (const s of [SENTINEL_NAME, SENTINEL_ID]) for (const e of encodings(s)) expect(wire).not.toContain(e);
      if (p.endCursor) {
        // the token is opaque to anyone but the server: it is not base64/JSON of a position
        const raw = Buffer.from(p.endCursor, 'base64url').toString('latin1');
        for (const s of [SENTINEL_NAME, SENTINEL_ID, 'name', '"id"']) expect(raw).not.toContain(s);
      }
    }
  });

  it('the token a scan ends on (a hidden row) names nothing: its position is the 500th hidden row', async () => {
    const rows = Array.from({ length: EXTENDED_BY_SCAN_CAP + 5 }, (_, i) => ({
      id: generateId(), urn: `h${n}-${i}.example:h`, name: `00-h-${String(i).padStart(4, "0")}`,
      extendsAgentId: parent.id, organizationId: orgB.id, visibility: 'ORGANIZATION' as const,
    }));
    await db.agent.createMany({ data: rows as never });
    const lastScanned = rows[EXTENDED_BY_SCAN_CAP - 1]; // name order == index order
    const p = await page(parent, { first: 1 }, await appCtx());
    expect(p.items).toEqual([]);
    expect(p.hasMore).toBe(true);
    const wire = JSON.stringify(p);
    for (const e of [...encodings(lastScanned.id), ...encodings(lastScanned.name), ...encodings(SENTINEL_NAME)]) expect(wire).not.toContain(e);
    // and it really is the 500th row's position, server-side only
    const c = await appCtx();
    const p2 = await page(parent, { first: 1 }, c);
    expect(openExtendedByCursor(p2.endCursor!, { base: parent.id, aud: extendedByAudience({ appId: c.appId, admin: false }) })).toBe(lastScanned.id);
  }, 60_000);

  it('a token minted for a long, Unicode name stays within the accepted size and resumes', async () => {
    for (let i = 0; i < 3; i++) await child(`${'日本語の長い名前'.repeat(40)}-${i}`, { organizationId: orgA.id, visibility: 'PUBLIC' });
    const p1 = await page(parent, { first: 1 }, asUser(memberA));
    expect(p1.endCursor!.length).toBeLessThanOrEqual(EXTENDED_BY_CURSOR_MAX_LENGTH);
    expect((await page(parent, { first: 1, after: p1.endCursor }, asUser(memberA))).items.length).toBe(1);
  });

  describe('refusals: one error for every defect', () => {
    const bind = (c: Context, base = parent.id) => ({
      base, aud: extendedByAudience({ userId: c.userId, appId: c.appId, admin: false, impersonationOrgId: null }),
    });
    const seal = (id: string, c: Context, over: Partial<{ base: string }> = {}) => sealExtendedByCursor(id, bind(c, over.base));

    it('tampered, truncated, non-token, over-long, empty', async () => {
      const c = asUser(memberA);
      const good = seal(kids['aaa-public-b'], c);
      const flipped = good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21);
      // The over-long case is a DoS bound (refused before any decrypt), not an integrity check: a long token would fail GCM anyway.
      for (const bad of [flipped, good.slice(0, -4), 'not a token!', 'A'.repeat(EXTENDED_BY_CURSOR_MAX_LENGTH + 1), '']) {
        expect(await code(page(parent, { first: 1, after: bad }, c))).toBe('BAD_USER_INPUT');
      }
    });

    it('wrong parent, wrong principal, expired, unknown version, unknown or foreign row', async () => {
      const c = asUser(memberA);
      const otherParent = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:p2`, name: 'p2', visibility: 'PUBLIC' } });
      const msgs: string[] = [];
      const attempt = async (tok: string, ctx: Context = c) => {
        const e = await page(parent, { first: 1, after: tok }, ctx).then(() => null, (x: Error) => x);
        expect(e).not.toBeNull();
        msgs.push(e!.message);
      };
      await attempt(seal(kids['aaa-public-b'], c, { base: otherParent.id }));              // wrong parent
      await attempt(seal(kids['aaa-public-b'], c), asUser(stranger));                       // wrong principal
      await attempt(sealExtendedByCursor(kids['aaa-public-b'], bind(c), Date.now() - 3_600_000)); // expired
      // url-safe, exactly as sealExtendedByCursor emits, so the token reaches the version check instead of the charset guard (Rook §10 P2-1)
      const nextVersion = encryptToken(JSON.stringify({ v: EXTENDED_BY_CURSOR_VERSION + 1, exp: Date.now() + 60_000, ...bind(c), id: kids['aaa-public-b'] }))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(nextVersion).toMatch(/^[A-Za-z0-9_-]+$/);
      await attempt(nextVersion);
      await attempt(seal(generateId(), c));                                                 // no such row
      await attempt(seal(otherParent.id, c));                                               // exists, not a child of this parent
      expect(new Set(msgs)).toEqual(new Set(['invalid cursor']));
    });

    it('a token minted under one impersonation org fails under another org and without impersonation (Rook §10 P2-2)', async () => {
      const imp = (orgId: string): Context => ({
        db, userId: memberA, roles: ['READER'],
        impersonation: { sessionId: 'imp-session', actorUserId: admin, orgId, expiresAt: new Date(Date.now() + 3_600_000) },
      } as Context);
      const underA = imp(orgA.id);
      const token = sealExtendedByCursor(kids['aaa-public-b'], {
        base: parent.id, aud: extendedByAudience({ userId: memberA, admin: false, impersonationOrgId: orgA.id }),
      });
      // Control: the same subject under the same impersonation org opens it.
      await expect(page(parent, { first: 1, after: token }, underA)).resolves.toBeDefined();
      for (const other of [imp(orgB.id), asUser(memberA)]) {
        const e = await page(parent, { first: 1, after: token }, other).then(() => null, (x: Error) => x);
        expect(e?.message).toBe('invalid cursor');
      }
    });

    it('a token opened with the wrong binding throws the one error type', () => {
      const t = sealExtendedByCursor('x', { base: 'p', aud: 'a' });
      expect(() => openExtendedByCursor(t, { base: 'p', aud: 'b' })).toThrow(InvalidExtendedByCursorError);
      expect(openExtendedByCursor(t, { base: 'p', aud: 'a' })).toBe('x');
    });

    it('a valid token does not widen visibility: membership revoked between pages is re-evaluated', async () => {
      for (let i = 0; i < 3; i++) await child(`r-${i}`, { organizationId: orgA.id, visibility: 'ORGANIZATION' });
      const c = asUser(memberA);
      const p1 = await page(parent, { first: 1 }, c);
      await db.orgMember.deleteMany({ where: { userId: memberA } });
      const p2 = await page(parent, { first: 10, after: p1.endCursor }, c);
      for (const k of ['bbb-org-a', 'r-0', 'r-1', 'r-2']) expect(ids(p2)).not.toContain(kids[k]);
    });
  });
});
