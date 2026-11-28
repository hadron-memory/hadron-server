/**
 * #4865 — `ResendSender.domainVerified`, slice 2 of epic #4872 (the server half of hadron-cli#2588).
 *
 * A read-only, report-only field with three states. `true`: Resend reports the from-domain verified.
 * `false`: Resend reports it unverified, or has no record of it. `null`: the state could not be read.
 *
 * Core never calls Resend (hrn:node:hadronmemory.com:specs:cor:int:030:01). One lookup is one call to the
 * capability tool's `get-domain-status` op (hadrontool-resend#3) with the org's key inline, exactly as
 * `sendResendEmail` sends — and it happens only AFTER the sender's own read gate. The tool is mocked here
 * for every state: these pins run the real field resolver, composition and client against a stubbed `fetch`.
 */
import { ApolloServer } from '@apollo/server';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { encryptResendApiKey } from '../../../lib/resendSenders.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const TOOL_URL = 'http://hadrontool-resend.test:8080';
const TOOL_TOKEN = 'shared-token';
/** The org's Resend key as an admin stored it: it travels in the request body, and nowhere else. */
const API_KEY = 're_org_secret_4865';
const DOMAIN = 'acme.example';
/** The stated bound on ONE lookup: the tool caps its own Resend call at 10 s, core waits 12 s. */
const LOOKUP_BOUND_MS = 12_000;

/** The real timer, kept before anything is faked, so a hung pin fails with a message instead of timing out. */
const REAL_SET_TIMEOUT: (fn: () => void, ms: number) => unknown = globalThis.setTimeout;
const realTimeout = (ms: number) =>
  new Promise<'watchdog'>((resolve) => {
    REAL_SET_TIMEOUT(() => resolve('watchdog'), ms);
  });

type SenderRow = Awaited<ReturnType<typeof db.resendSender.findUniqueOrThrow>>;
type ToolStatus = 'verified' | 'unverified' | 'not_found';

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let fetchMock: ReturnType<typeof vi.fn>;
let warn: MockInstance<(...data: unknown[]) => void>;

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A well-formed answer of the tool's `get-domain-status` op. */
function toolAnswers(status: ToolStatus): Response {
  return jsonResponse(200, { ok: true, domain: DOMAIN, status });
}

/** The request one lookup made, as it left core. */
function sentRequest(call = 0): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

/** A fetch that never answers on its own: it rejects only when core aborts the request. */
function hangUntilAborted(): Promise<AbortSignal | null | undefined> {
  let announce: (signal: AbortSignal | null | undefined) => void = () => {};
  const request = new Promise<AbortSignal | null | undefined>((resolve) => {
    announce = resolve;
  });
  fetchMock.mockImplementation((_url: string, init: RequestInit) => {
    announce(init.signal);
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });
  });
  return request;
}

async function createUser(name: string, orgId: string | null, role: 'ADMIN' | 'READER' = 'READER') {
  const user = await db.user.create({ data: { id: generateId(), email: `${name}@resend.test`, name } });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

async function createSender(overrides: Record<string, unknown> = {}, ctx = ctxFor(admin.id)) {
  return resolvers.Mutation.createResendSender(
    {},
    {
      orgRef: org.id,
      from: 'Acme Agent <agent@acme.example>',
      apiKey: API_KEY,
      ...overrides,
    } as never,
    ctx,
  );
}

async function rawRow(id: string): Promise<SenderRow> {
  return db.resendSender.findUniqueOrThrow({ where: { id } });
}

/** The field resolver by hand, as the executor would call it for one `ResendSender`. */
async function readField(row: SenderRow, ctx: Context): Promise<boolean | null> {
  const resolve = resolvers.ResendSender.domainVerified;
  expect(resolve, 'ResendSender.domainVerified is not a field resolver').toBeTypeOf('function');
  return resolve(row, {}, ctx);
}

const apollo = new ApolloServer<Context>({ typeDefs, resolvers });

/** One operation through the real schema and executor, so the SDL wiring is under test too. */
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await apollo.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental delivery');
  const { data, errors } = res.body.singleResult;
  expect(errors ?? [], 'the operation must not report an error').toEqual([]);
  return data as Record<string, any>;
}

/** Every line the lookup logged, parsed. */
function logged(): Array<Record<string, unknown>> {
  return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'resend-org', urn: 'resend-org' },
  });
  admin = await createUser('admin', org.id, 'ADMIN');
  member = await createUser('member', org.id);
  outsider = await createUser('outsider', null);
  process.env.RESEND_TOOL_URL = TOOL_URL;
  process.env.RESEND_TOOL_TOKEN = TOOL_TOKEN;
  fetchMock = vi.fn().mockResolvedValue(toolAnswers('verified'));
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.RESEND_TOOL_URL;
  delete process.env.RESEND_TOOL_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('#4865 SDL', () => {
  it('ResendSender.domainVerified is a nullable Boolean that says when it is null and that it is read live', () => {
    const sender = buildSchema(typeDefs).getType('ResendSender') as GraphQLObjectType | undefined;
    expect(sender, 'ResendSender is not in the schema').toBeDefined();
    const field = sender!.getFields().domainVerified;
    expect(field, 'ResendSender.domainVerified is not in the SDL').toBeDefined();
    expect(String(field!.type)).toBe('Boolean');
    // The description as a reader sees it, its line breaks folded.
    const description = field!.description!.replace(/\s+/g, ' ');
    // The gate's two prose requirements: when it is null, and its staleness.
    expect(description).toContain('true:');
    expect(description).toContain('false:');
    expect(description).toContain('null:');
    expect(description).toContain('no record of the domain');
    expect(description).toContain('not configured');
    expect(description).toContain('failed or ran past its bound of 12 seconds');
    expect(description).toContain('never cached');
    expect(description).toContain('one tool call per sender');
    expect(description).toContain('A null says nothing about the domain');
    expect(description).toContain('hrn:node:hadronmemory.com:specs:cor:int:030:01');
  });
});

describe('#4865 the three states, each asked of the tool with the org key inline', () => {
  it('verified answers true, from ONE POST to the tool op carrying the domain and the key, and nothing else', async () => {
    const row = await rawRow((await createSender()).id);
    expect(await readField(row, ctxFor(member.id))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init, body } = sentRequest();
    expect(url).toBe(`${TOOL_URL}/ops/get-domain-status`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: `Bearer ${TOOL_TOKEN}`,
    });
    expect(body).toEqual({ domain: DOMAIN, apiKey: API_KEY });
    expect(logged()).toEqual([]);
  });

  it('unverified answers false', async () => {
    fetchMock.mockResolvedValue(toolAnswers('unverified'));
    const row = await rawRow((await createSender()).id);
    expect(await readField(row, ctxFor(member.id))).toBe(false);
    expect(logged()).toEqual([]);
  });

  it('a domain Resend has no record of answers false, the same as an unverified one, not null', async () => {
    fetchMock.mockResolvedValue(toolAnswers('not_found'));
    const row = await rawRow((await createSender()).id);
    expect(await readField(row, ctxFor(member.id))).toBe(false);
    expect(logged()).toEqual([]);
  });

  it('a list asks for each sender with that sender\'s own key', async () => {
    const other = await db.organization.create({
      data: { id: generateId(), name: 'other-org', urn: 'other-org' },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: other.id, userId: member.id, role: 'READER' },
    });
    await createSender();
    await db.resendSender.create({
      data: {
        id: generateId(),
        organizationId: other.id,
        fromAddress: 'Ops <ops@beta.example>',
        apiKeyEncrypted: encryptResendApiKey('re_beta_key'),
      },
    });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const { domain } = JSON.parse(String(init.body)) as { domain: string };
      const status: ToolStatus = domain === 'beta.example' ? 'unverified' : 'verified';
      return Promise.resolve(jsonResponse(200, { ok: true, domain, status }));
    });

    const data = await run('{ resendSenders { items { from domainVerified } } }', ctxFor(member.id));
    expect(data.resendSenders.items).toEqual([
      { from: 'Acme Agent <agent@acme.example>', domainVerified: true },
      { from: 'Ops <ops@beta.example>', domainVerified: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Not by call index: the two list items are resolved concurrently, so the order is not fixed.
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual(
      expect.arrayContaining([
        { domain: DOMAIN, apiKey: API_KEY },
        { domain: 'beta.example', apiKey: 're_beta_key' },
      ]),
    );
  });
});

describe('#4865 null: the state could not be read', () => {
  it('the tool is not configured: null, nothing sent, nothing logged', async () => {
    delete process.env.RESEND_TOOL_URL;
    const row = await rawRow((await createSender()).id);
    expect(await readField(row, ctxFor(member.id))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it('a tool error answers null, fails no read, and logs its class and status', async () => {
    const row = await rawRow((await createSender()).id);
    fetchMock.mockResolvedValue(
      jsonResponse(502, { error: 'upstream_unreachable', message: 'Resend could not be reached.' }),
    );
    const data = await run(
      'query ($ref: ID!) { resendSender(ref: $ref) { id domainVerified } }',
      ctxFor(member.id),
      { ref: row.id },
    );
    expect(data.resendSender).toEqual({ id: row.id, domainVerified: null });
    expect(logged()).toEqual([
      { event: 'resend_domain_verified_unavailable', reason: 'tool_error', status: 502 },
    ]);
  });

  it('every other tool error answers null too: validation, unauthorized, rate-limited, upstream timeout', async () => {
    const row = await rawRow((await createSender()).id);
    for (const [status, error] of [
      [400, 'validation_error'],
      [401, 'unauthorized'],
      [429, 'provider_rate_limited'],
      [504, 'upstream_timeout'],
    ] as const) {
      fetchMock.mockResolvedValue(jsonResponse(status, { error, message: `${error}: see the tool logs` }));
      expect(await readField(row, ctxFor(member.id)), `HTTP ${status} ${error}`).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('a non-2xx answer is null even when its body looks like a verified answer', async () => {
    const row = await rawRow((await createSender()).id);
    fetchMock.mockResolvedValue(jsonResponse(502, { ok: true, domain: DOMAIN, status: 'verified' }));
    expect(await readField(row, ctxFor(member.id))).toBeNull();
    expect(logged()).toEqual([
      { event: 'resend_domain_verified_unavailable', reason: 'tool_error', status: 502 },
    ]);
  });

  it('a tool that cannot be reached answers null', async () => {
    const row = await rawRow((await createSender()).id);
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await readField(row, ctxFor(member.id))).toBeNull();
    expect(logged()).toEqual([{ event: 'resend_domain_verified_unavailable', reason: 'unreachable' }]);
  });

  it('a malformed answer is null: an unknown status, a missing ok, another domain, a non-JSON body', async () => {
    const row = await rawRow((await createSender()).id);
    for (const answer of [
      jsonResponse(200, { ok: true, domain: DOMAIN, status: 'pending' }),
      jsonResponse(200, { domain: DOMAIN, status: 'verified' }),
      jsonResponse(200, { ok: true, domain: 'other.example', status: 'verified' }),
      new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      jsonResponse(200, { ok: 'yes', domain: DOMAIN, status: 'verified' }),
    ]) {
      fetchMock.mockResolvedValue(answer);
      expect(await readField(row, ctxFor(member.id))).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(logged()).toEqual(
      Array.from({ length: 5 }, () => ({
        event: 'resend_domain_verified_unavailable',
        reason: 'malformed_answer',
        status: 200,
      })),
    );
  });

  it('a lookup that runs past its bound answers null at the bound, and its request is aborted', async () => {
    expect(resolvers.ResendSender.domainVerified).toBeTypeOf('function');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const row = await rawRow((await createSender()).id);
    const request = hangUntilAborted();
    const pending = readField(row, ctxFor(member.id));
    const reached = await Promise.race([request, realTimeout(2_000)]);
    if (reached === 'watchdog' || !reached) throw new Error('the lookup never reached the tool');
    const signal: AbortSignal = reached;
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(LOOKUP_BOUND_MS - 1);
    let answered: unknown = 'pending';
    void pending.then(
      (value) => { answered = value; },
      () => { answered = 'rejected'; },
    );
    await turn();
    expect(answered, 'answered before its bound').toBe('pending');
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(logged()).toEqual([{ event: 'resend_domain_verified_unavailable', reason: 'timeout' }]);
  });
});

describe('#4865 authorize first: the sender\'s own read gate, and no new access path', () => {
  it('a caller outside the sender\'s organization reads null and no lookup is made, even when handed the row', async () => {
    const row = await rawRow((await createSender()).id);
    expect(await readField(row, ctxFor(outsider.id))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it('an App key lists its own org\'s sender and reads null for this field, with no lookup', async () => {
    await createSender();
    const app = await db.app.create({
      data: { name: 'Team', urn: `${org.urn}:team`, organizationId: org.id },
    });
    const data = await run('{ resendSenders { items { id domainVerified } } }', { db, appId: app.id } as Context);
    expect(data.resendSenders.items).toHaveLength(1);
    expect(data.resendSenders.items[0].domainVerified).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toEqual([]);
  });

  it('the sender read\'s existing refusals are unchanged, and none of them reaches the tool', async () => {
    const sender = await createSender();
    expect(await resolvers.Query.resendSender({}, { ref: sender.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.resendSender({}, { ref: 'missing' }, ctxFor(member.id))).toBeNull();
    expect(await resolvers.Query.resendSenders({}, { orgRef: org.id }, ctxFor(outsider.id))).toEqual({
      items: [],
      total: 0,
    });
    expect(await run('{ resendSender(ref: "missing") { domainVerified } }', ctxFor(member.id))).toEqual({
      resendSender: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('#4865 what is asked, and what is kept', () => {
  it('the domain asked for is that of the from address, lowercased, from a display-name form and a bare one', async () => {
    const sender = await createSender({ from: 'Ops <OPS@Acme.Example>' });
    await readField(await rawRow(sender.id), ctxFor(member.id));
    expect(sentRequest().body).toEqual({ domain: DOMAIN, apiKey: API_KEY });

    fetchMock.mockClear();
    const bare = await resolvers.Mutation.updateResendSender(
      {},
      { ref: sender.id, from: 'ops@acme.example' },
      ctxFor(admin.id),
    );
    await readField(await rawRow(bare.id), ctxFor(member.id));
    expect(sentRequest().body).toEqual({ domain: DOMAIN, apiKey: API_KEY });
  });

  it('a disabled sender is still reported', async () => {
    const sender = await createSender();
    const disabled = await resolvers.Mutation.updateResendSender(
      {},
      { ref: sender.id, enabled: false },
      ctxFor(admin.id),
    );
    expect(await readField(await rawRow(disabled.id), ctxFor(member.id))).toBe(true);
  });

  it('a failed lookup hands the caller null only, and the key reaches no log line', async () => {
    const row = await rawRow((await createSender()).id);
    fetchMock.mockResolvedValue(
      jsonResponse(502, { error: 'upstream_unreachable', message: `Resend refused key ${API_KEY}` }),
    );
    const data = await run(
      'query ($ref: ID!) { resendSender(ref: $ref) { id domainVerified } }',
      ctxFor(member.id),
      { ref: row.id },
    );
    expect(JSON.stringify(data)).not.toContain(API_KEY);
    expect(data.resendSender.domainVerified).toBeNull();
    // The transport's own text is not repeated either.
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED ${API_KEY}`));
    expect(await readField(row, ctxFor(member.id))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(API_KEY);
    }
  });

  it('a stored key that does not decrypt is a fault, not a state: it is not answered with null', async () => {
    const row = await rawRow((await createSender()).id);
    const corrupted = await db.resendSender.update({
      where: { id: row.id },
      data: { apiKeyEncrypted: 'bm90IGEgcmVhbCBjaXBoZXJ0ZXh0' },
    });
    // The decrypt fault itself, as tokenCrypto raises it: not null, and not a tool answer.
    await expect(readField(corrupted, ctxFor(member.id))).rejects.toThrow('ciphertext shorter than iv(12)+tag(16)');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
