/**
 * #5486 (#415 Slice 2): a regex pattern is bounded (200 chars), may not backreference, and a caller is throttled
 * (one statement in flight, 10 a minute, counted on the principal). Refusals carry fixed words, never the pattern;
 * the pattern refusals are BAD_USER_INPUT (the portal's "invalid pattern"), the throttle is RATE_LIMITED.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { assertRegexPatternAllowed, hasRegexBackreference, hasRegexInlineComment, selectsNonAreSyntax, REGEX_PATTERN_MAX_CHARS } from './regexGuard.js';
import { REGEX_SEARCH_PER_WINDOW, REGEX_SEARCH_WINDOW_SECONDS, withRegexSearchSlot } from '../rateLimit/index.js';
import { postgresRetrievalProvider } from './postgres.js';
import { rateWindowWaitMs, RATE_WINDOW_TEST_TIMEOUT_MS } from '../../test/rateWindow.js';

/** Sleep past the boundary when less than the margin remains in the 60 s window, so a sequence fits in one window. */
const untilRoom = () => new Promise<void>((r) => setTimeout(r, rateWindowWaitMs(Date.now() % (REGEX_SEARCH_WINDOW_SECONDS * 1000), REGEX_SEARCH_WINDOW_SECONDS)));

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

describe('#5486 SEC10 P2-1, P2-2: a leading option that selects the basic, extended or expanded syntax is refused', () => {
  it.each([String.raw`(?b)\(a\)[\]\1`, String.raw`(?bi)\(a\)[\]\1`, '(?e)a', '(?ie)a', '(?x)(a)#[\n\\1]', '(?ix)(a)#[\n\\1]', '***:(?x)(a)#[\n\\1]', '(?x)a#[b\n(a)\\1', '(?x)a b', '***:(?b)a', '(?i)(?b)a'])('refuses %s', (p) => {
    expect(selectsNonAreSyntax(p)).toBe(true);
    expect(() => assertRegexPatternAllowed(p)).toThrow(/basic, extended or expanded/);
  });
  it.each(['(?i)abc', '***:(?i)a', 'a(?b)', 'abc', '(?q)a.b', '(?s)(?i)x'])('allows %s', (p) => expect(selectsNonAreSyntax(p)).toBe(false));
});

describe('#5486 SEC10 P2-3: an inline (?#...) comment is refused', () => {
  it.each([String.raw`(a)(?#[)\1]`, String.raw`(a)(?#[)\1`, '(?#x)abc', 'a(?#c)b'])('refuses %s', (p) => {
    expect(hasRegexInlineComment(p)).toBe(true);
    expect(() => assertRegexPatternAllowed(p)).toThrow(/may not contain a comment/);
  });
  it.each([String.raw`\(?#x)`, '[(?#]', '(?:a)', '(?=a)', '(?i)a', 'a?#b'])('allows %s', (p) => expect(hasRegexInlineComment(p)).toBe(false));
});

describe('#5486 SEC10 P2-4: the control escape \\cX takes three characters, so what follows it is read as the engine reads it', () => {
  it.each([String.raw`(a)\c[\1]`, String.raw`(a)\c[\1`, String.raw`(a)\c\\1`, String.raw`(a)[\c\]\1]`])('a backreference after %s is refused', (p) => {
    expect(hasRegexBackreference(p)).toBe(true);
  });
  it('a (?# comment hidden behind \\c[ is still seen', () => expect(hasRegexInlineComment(String.raw`\c[(?#x)`)).toBe(true));
  it.each([String.raw`\cA`, String.raw`(a)\cA\\1`, String.raw`[\cA]`, String.raw`a\c[b]`])('allows %s', (p) => expect(hasRegexBackreference(p)).toBe(false));
});

describe('#5486 hasRegexBackreference (a scanner, not a substring test)', () => {
  it.each([
    String.raw`(a)\1`, String.raw`(a)(b)\2`, String.raw`(a)\10`, String.raw`((a)b)\2`, String.raw`x\9`, String.raw`(?b)\(a\)\1`,
    String.raw`[a]\1`, String.raw`\\\1`, String.raw`(a)\1+`,
  ])('refuses %s', (p) => expect(hasRegexBackreference(p)).toBe(true));
  it.each([
    'plain', 'a|b', 'foo.*bar', String.raw`\\1`, String.raw`\\\\12`, String.raw`[\1]`, String.raw`[^\1]`, String.raw`[]\1]`, String.raw`[[:digit:]\1]`,
    String.raw`[\]\1]`, String.raw`\d+`, String.raw`\.1`, String.raw`(a)(b)`, String.raw`[a-z]1`, String.raw`\0`,
  ])('allows %s', (p) => expect(hasRegexBackreference(p)).toBe(false));
  it('a pattern at the cap passes and one past it is refused, without echoing the pattern', () => {
    expect(() => assertRegexPatternAllowed('a'.repeat(REGEX_PATTERN_MAX_CHARS))).not.toThrow();
    const long = 'zzq' + 'a'.repeat(REGEX_PATTERN_MAX_CHARS);
    try { assertRegexPatternAllowed(long); expect.unreachable(); } catch (e: any) {
      expect(e.extensions.code).toBe('BAD_USER_INPUT');
      expect(e.message).not.toContain('zzq');
    }
    try { assertRegexPatternAllowed('(secretx)\\1'); expect.unreachable(); } catch (e: any) {
      expect(e.extensions.code).toBe('BAD_USER_INPUT');
      expect(e.message).not.toContain('secretx');
    }
  });
});

const ring = { current: 'k1', keys: { k1: '2'.repeat(64) } };
let memoryId: string;
let userA: string; let userB: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const find = (args: Record<string, unknown>, ctx: Context) => (resolvers.Query as any).findNodes(null, args, ctx);

beforeEach(async () => {
  vi.stubEnv('RATE_LIMIT_KEYRING', JSON.stringify(ring));
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rx Org', urn: 'rx5486.example' } });
  userA = (await db.user.create({ data: { id: generateId(), handle: 'rx-a', roles: [] } })).id;
  userB = (await db.user.create({ data: { id: generateId(), handle: 'rx-b', roles: [] } })).id;
  for (const u of [userA, userB]) await db.orgMember.create({ data: { organizationId: org.id, userId: u, role: 'ADMIN' } });
  const memory = await M.createMemory(null, { orgRef: org.id, name: 'rx' }, ctxOf(userA));
  memoryId = memory.id;
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'doc:1', name: 'Doc', content: 'foo bar baz' } });
});
afterEach(() => vi.unstubAllEnvs());

describe('#5486 findNodes regex through the resolver', () => {
  const base = (q: string) => ({ query: q, mode: 'regex', filter: { memoryRefs: [memoryId] }, limit: 5 });

  it('refuses an over-long pattern and a backreference BEFORE any search statement', async () => {
    const spy = vi.spyOn(postgresRetrievalProvider, 'regexSearch');
    for (const q of ['a'.repeat(201), String.raw`(a)\1`]) {
      await expect(find(base(q), ctxOf(userA))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an ordinary pattern still runs', async () => {
    const spy = vi.spyOn(postgresRetrievalProvider, 'regexSearch');
    const r = await find(base('foo.*'), ctxOf(userA));
    expect(spy).toHaveBeenCalledTimes(1); // the spy is wired to the provider the resolver uses
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].node.name).toBe('Doc');
    spy.mockRestore();
  });

  it('refuses the 11th regex search in a window with RATE_LIMITED and a positive retryAfterSeconds; another caller is unaffected', async () => {
    await untilRoom(); {
      for (let i = 0; i < REGEX_SEARCH_PER_WINDOW; i++) await find(base(`x${i}`), ctxOf(userA));
      const err: any = await find(base('x11'), ctxOf(userA)).then(() => null, (e: unknown) => e);
      expect(err?.extensions?.code).toBe('RATE_LIMITED');
      expect(err.extensions.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(err.extensions.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(JSON.stringify(err.extensions)).not.toContain('x11');
      await expect(find(base('x11'), ctxOf(userB))).resolves.toBeDefined();
    }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('a pattern refusal does not spend the window', async () => {
    await untilRoom(); {
      for (let i = 0; i < 15; i++) await find(base(String.raw`(a)\1`), ctxOf(userA)).catch(() => {});
      await expect(find(base('ok'), ctxOf(userA))).resolves.toBeDefined();
    }
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('a second concurrent regex statement of the same caller is refused RATE_LIMITED, and the slot frees afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ident = { principal: `USER:${userA}`, internal: false } as const;
    const first = withRegexSearchSlot(db, ident, 5000, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await expect(withRegexSearchSlot(db, ident, 5000, async () => 1)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 5 } });
    await expect(withRegexSearchSlot(db, { principal: `USER:${userB}`, internal: false }, 5000, async () => 2)).resolves.toBe(2);
    release(); await first;
    await expect(withRegexSearchSlot(db, ident, 5000, async () => 3)).resolves.toBe(3);
  });

  it('SEC10 P3-1: a second credential of the same principal shares the count and the in-flight slot', async () => {
    const k1 = { principal: `USER:${userA}`, key: 'USER_KEY:k1', internal: false } as const;
    const k2 = { principal: `USER:${userA}`, key: 'USER_KEY:k2', internal: false } as const;
    await untilRoom();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = withRegexSearchSlot(db, k1, 5000, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await expect(withRegexSearchSlot(db, k2, 5000, async () => 1)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    release(); await first;
    for (let i = 1; i < REGEX_SEARCH_PER_WINDOW; i++) await withRegexSearchSlot(db, i % 2 ? k2 : k1, 5000, async () => i);
    await expect(withRegexSearchSlot(db, k2, 5000, async () => 0)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
    await expect(withRegexSearchSlot(db, k1, 5000, async () => 0)).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
  }, RATE_WINDOW_TEST_TIMEOUT_MS);

  it('through the resolver: a concurrent second regex search of one caller is RATE_LIMITED while the first is held', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(postgresRetrievalProvider, 'regexSearch').mockImplementationOnce(async () => { await gate; return []; });
    const first = find(base('held'), ctxOf(userA));
    await new Promise((r) => setTimeout(r, 100));
    const err: any = await find(base('second'), ctxOf(userA)).then(() => null, (e: unknown) => e);
    expect(err?.extensions?.code).toBe('RATE_LIMITED');
    expect(err.extensions.retryAfterSeconds).toBe(5);
    release(); await first;
    spy.mockRestore();
  });

  it('a throw in the statement frees the slot', async () => {
    const ident = { principal: `USER:${userA}`, internal: false } as const;
    await expect(withRegexSearchSlot(db, ident, 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withRegexSearchSlot(db, ident, 5000, async () => 1)).resolves.toBe(1);
  });
});
