/**
 * hadron-internal#3 L1-L3: bounds on every client-supplied GraphQL document, proved
 * through the REAL Express + Apollo stack (`createServer`) with spies on the real
 * resolvers. L4 (depth/cost of the selected operation) is not in this slice.
 *
 * GET note: Node's own header limit (16 KiB) answers before L1 can; the byte
 * boundary for GET is therefore pinned on a synthetic transport that raises
 * `maxHeaderSize`, and the real transport's earlier refusal is asserted separately.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse } from 'graphql';
import { createServer } from '../../server.js';
import { resolvers } from './schema/resolvers.js';
import {
  GRAPHQL_ADMISSION_DEFAULTS,
  QUERY_TOO_LARGE,
  querySourceCap,
  readGraphqlAdmissionConfig,
} from './admission.js';

const BYTES = GRAPHQL_ADMISSION_DEFAULTS.maxQueryBytes;
const servers: Server[] = [];

async function listen(app: express.Express, opts: { maxHeaderSize?: number } = {}): Promise<string> {
  const server = createHttpServer(opts, app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Boot the real app with the given admission env, restoring the environment after. */
async function bootReal(env: Record<string, string> = {}): Promise<string> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    return await listen(await createServer());
  } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

type Reply = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

const post = (base: string, body: unknown, path = '/graphql'): Promise<Reply> =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** `{ <marker> }` padded with a trailing comment so the source is exactly `n` UTF-8 bytes. */
function queryOfBytes(n: number, pad = ' '): string {
  const head = '{ __typename } #';
  const room = n - Buffer.byteLength(head);
  const unit = Buffer.byteLength(pad);
  const whole = Math.floor(room / unit);
  return head + pad.repeat(whole) + 'x'.repeat(room - whole * unit);
}

/** `{ serverInfo { version } a0:__typename ... }` with `n` extra fields. */
const aliasFlood = (n: number) =>
  `{ serverInfo { version } ${Array.from({ length: n }, (_, i) => `a${i}:__typename`).join(' ')} }`;

/** Smallest `maxTokens` under which graphql-js parses `doc`. */
function tokenCount(doc: string): number {
  let n = 1;
  for (;;) { try { parse(doc, { maxTokens: n }); return n; } catch { n++; } }
}

let base: string;
let serverInfoSpy: ReturnType<typeof vi.spyOn>;
let createNodeSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const Query = resolvers.Query as Record<string, (...a: unknown[]) => unknown>;
  const Mutation = resolvers.Mutation as Record<string, (...a: unknown[]) => unknown>;
  serverInfoSpy = vi.spyOn(Query, 'serverInfo').mockResolvedValue({ version: 'test' } as never);
  createNodeSpy = vi.spyOn(Mutation, 'createNode').mockRejectedValue(new Error('createNode reached'));
  base = await bootReal();
});

beforeEach(() => { serverInfoSpy.mockClear(); createNodeSpy.mockClear(); });

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  vi.restoreAllMocks();
});

const untouched = () => {
  expect(serverInfoSpy).not.toHaveBeenCalled();
  expect(createNodeSpy).not.toHaveBeenCalled();
};

describe('L1 query source bytes (POST, real stack)', () => {
  it('passes at exactly the limit and refuses one byte over, with the typed 413 envelope', async () => {
    serverInfoSpy.mockClear();
    const ok = await post(base, { query: queryOfBytes(BYTES) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toEqual({ __typename: 'Query' });

    const over = await post(base, { query: queryOfBytes(BYTES + 1) });
    expect(over.status).toBe(413);
    const body = await over.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].extensions).toEqual({ code: QUERY_TOO_LARGE, limit: 'bytes', max: BYTES });
    expect(body.errors[0].message).toBe('The GraphQL query is too large.');
    expect(over.headers.get('retry-after')).toBeNull();
  });

  it('counts UTF-8 bytes, not characters: a 3-byte character straddling the limit', async () => {
    // 3-byte '€' padding: exactly BYTES bytes passes; BYTES + 1 is refused although it has fewer characters than BYTES.
    expect((await post(base, { query: queryOfBytes(BYTES, '€') })).status).toBe(200);
    const q = queryOfBytes(BYTES + 1, '€');
    expect(q.length).toBeLessThan(BYTES);
    expect((await post(base, { query: q })).status).toBe(413);
  });

  it.each(['/graphql', '/graphql/', '/GRAPHQL'])('is mounted on %s', async (path) => {
    expect((await post(base, { query: queryOfBytes(BYTES + 1) }, path)).status).toBe(413);
    expect((await post(base, { query: queryOfBytes(BYTES) }, path)).status).toBe(200);
  });

  it('does not echo the query or variables in the refusal', async () => {
    const secret = 'SENTINEL_SECRET_VALUE';
    const res = await post(base, { query: `{ __typename } # ${secret} ${'x'.repeat(BYTES)}`, variables: { v: secret } });
    expect(res.status).toBe(413);
    expect(JSON.stringify(await res.json())).not.toContain(secret);
  });

  it('control: a small query carrying a 5 MB content variable is still admitted and reaches its resolver', async () => {
    createNodeSpy.mockClear();
    const res = await post(base, {
      query: 'mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }',
      variables: { i: { memoryId: 'x', loc: 'a', name: 'a', content: 'c'.repeat(5 * 1024 * 1024) } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).errors[0].message).toContain('createNode reached');
    expect(createNodeSpy).toHaveBeenCalledTimes(1);
    createNodeSpy.mockClear(); // its recorded call holds the 5 MB variable
  });

  it('leaves a missing or non-string query to Apollo', async () => {
    expect((await post(base, {})).status).toBe(400);
    expect((await post(base, { query: 42 })).status).toBe(400);
    expect((await post(base, [{ query: '{ __typename }' }])).status).toBe(400); // batching stays refused
  });

  it('does not intercept /graphql/schema or other JSON routes', async () => {
    const res = await fetch(`${base}/graphql/schema?query=${'x'.repeat(8000)}`);
    expect(res.status).toBe(401); // the route's own anonymous refusal, not 413
  });

  it('APQ: an oversize registration is refused, so its hash never becomes usable', async () => {
    const big = queryOfBytes(BYTES + 1);
    const sha256Hash = createHash('sha256').update(big).digest('hex');
    const ext = { persistedQuery: { version: 1, sha256Hash } };
    expect((await post(base, { query: big, extensions: ext })).status).toBe(413);
    const hashOnly = await (await post(base, { extensions: ext })).json();
    expect(hashOnly.errors[0].extensions.code).toBe('PERSISTED_QUERY_NOT_FOUND');
    // A within-limit full-source registration works and the hash alone then resolves (source this request did not supply).
    const small = '{ __typename }';
    const smallExt = { persistedQuery: { version: 1, sha256Hash: createHash('sha256').update(small).digest('hex') } };
    expect((await (await post(base, { query: small, extensions: smallExt })).json()).data).toEqual({ __typename: 'Query' });
    expect((await (await post(base, { extensions: smallExt })).json()).data).toEqual({ __typename: 'Query' });
  });
});

describe('L1 (GET)', () => {
  it('synthetic transport: exactly the limit passes and one over is refused, with duplicate params both checked', async () => {
    const app = express();
    app.use('/graphql', querySourceCap(BYTES), (_req, res) => { res.json({ ok: true }); });
    const url = await listen(app, { maxHeaderSize: 256 * 1024 });
    const get = (q: string) => fetch(`${url}/graphql?query=${encodeURIComponent(q)}`);
    expect((await get(queryOfBytes(BYTES))).status).toBe(200);
    expect((await get(queryOfBytes(BYTES + 1))).status).toBe(413);
    expect((await fetch(`${url}/graphql?query=a&query=${encodeURIComponent(queryOfBytes(BYTES + 1))}`)).status).toBe(413);
  });

  it('real transport: a small GET works, and a GET past Node\'s 16 KiB header limit is refused earlier (431), not by L1', async () => {
    const ok: Reply = await fetch(`${base}/graphql?query=${encodeURIComponent('{ __typename }')}`, { headers: { 'apollo-require-preflight': 'true' } });
    expect((await ok.json()).data).toEqual({ __typename: 'Query' });
    const big = await fetch(`${base}/graphql?query=${encodeURIComponent(queryOfBytes(20 * 1024))}`);
    expect(big.status).toBe(431);
  });
});

describe('L2 parser tokens (real stack, defaults)', () => {
  const T = GRAPHQL_ADMISSION_DEFAULTS.maxTokens;
  // Selection-light, token-heavy: `{ __typename @include(if: true) ... }` is 3 + 7 per directive tokens.
  const tokenHeavy = (directives: number) => `{ __typename${' @include(if: true)'.repeat(directives)} }`;

  it('refuses a document over the token cap before resolvers or validation', async () => {
    const doc = tokenHeavy(Math.ceil((T - 3) / 7) + 1);
    expect(tokenCount(doc)).toBeGreaterThan(T);
    const res = await post(base, { query: doc });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].extensions.code).toBe('GRAPHQL_PARSE_FAILED');
  });

  it('control: a document under the cap is not refused as a parse failure', async () => {
    const doc = tokenHeavy(Math.floor((T - 3) / 7)); // exactly T tokens
    expect(tokenCount(doc)).toBe(T);
    const body = await (await post(base, { query: doc })).json();
    expect(body.errors?.[0]?.extensions?.code).not.toBe('GRAPHQL_PARSE_FAILED');
  });
});

describe('L3 expanded selections (real stack, defaults)', () => {
  const S = GRAPHQL_ADMISSION_DEFAULTS.maxSelections;

  it('flat alias flood: at the limit it executes; one over is refused with no resolver call', async () => {
    serverInfoSpy.mockClear();
    const ok = await post(base, { query: aliasFlood(S - 2) }); // serverInfo + its `version` leaf + (S-2) aliases = S selections
    const okBody = await ok.json();
    expect(okBody.errors).toBeUndefined();
    expect(okBody.data.a0).toBe('Query');
    expect(serverInfoSpy).toHaveBeenCalledTimes(1);

    serverInfoSpy.mockClear();
    const over = await post(base, { query: aliasFlood(S - 1) }); // S + 1 selections
    expect(over.status).toBe(400);
    expect((await over.json()).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    untouched();
  });

  it('small-source fragment amplification is refused though its source passes L1 and L2', async () => {
    const k = 4, levels = 8; // 4^8 = 65,536 expanded selections from a few hundred bytes
    const frags = [`fragment F0 on Query { __typename }`];
    for (let i = 1; i < levels; i++) frags.push(`fragment F${i} on Query { ${Array(k).fill(`...F${i - 1}`).join(' ')} }`);
    const query = `{ serverInfo { version } ...F${levels - 1} } ${frags.join(' ')}`;
    expect(Buffer.byteLength(query)).toBeLessThan(BYTES / 10);
    expect(tokenCount(query)).toBeLessThan(GRAPHQL_ADMISSION_DEFAULTS.maxTokens);
    const res = await post(base, { query });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    untouched();
  });

  it('a document with one over-limit UNSELECTED operation is refused at document level, never executed', async () => {
    const query = `query Small { serverInfo { version } } query Big ${aliasFlood(S + 5).replace('{ serverInfo { version } ', '{ ')}`;
    const res = await post(base, { query, operationName: 'Small' });
    expect(res.status).toBe(400);
    untouched();
  });

  it('refused mutations perform no write: createNode is never invoked', async () => {
    const query = `mutation($i: CreateNodeInput!) { createNode(input: $i) { id } ${Array.from({ length: S + 5 }, (_, i) => `a${i}:__typename`).join(' ')} }`;
    expect((await post(base, { query, variables: { i: {} } })).status).toBe(400);
    untouched();
  });
});

describe('unchanged behaviour', () => {
  it('unknown operationName stays an ordinary refusal and a valid query returns data', async () => {
    const bad = await post(base, { query: '{ __typename }', operationName: 'Nope' });
    expect(bad.status).toBe(400);
    expect((await (await post(base, { query: '{ __typename }' })).json()).data).toEqual({ __typename: 'Query' });
  });
});

describe('configuration', () => {
  it('each variable moves its own bound with no code change', async () => {
    const url = await bootReal({ GRAPHQL_MAX_QUERY_BYTES: '300', GRAPHQL_MAX_TOKENS: '40', GRAPHQL_MAX_SELECTIONS: '5' });
    expect((await post(url, { query: queryOfBytes(300) })).status).toBe(200);
    expect((await post(url, { query: queryOfBytes(301) })).status).toBe(413);
    const doc = `{ ${Array.from({ length: 5 }, (_, i) => `a${i}:__typename`).join(' ')} }`;
    expect((await (await post(url, { query: doc })).json()).data.a0).toBe('Query');
    expect((await (await post(url, { query: doc.replace('}', ' a5:__typename }') })).json()).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    const t = tokenCount(doc);
    expect(t).toBeLessThan(40);
    const wide = `{ ${Array.from({ length: 14 }, (_, i) => `a${i}:__typename`).join(' ')} }`;
    expect((await (await post(url, { query: wide })).json()).errors[0].extensions.code).toBe('GRAPHQL_PARSE_FAILED');
  });

  it.each(['0', '-1', '1.5', '', 'abc', '10kb', ' 5', '0x10', '99999999999999999999'])('refuses boot on a malformed value %j', (v) => {
    for (const name of ['GRAPHQL_MAX_QUERY_BYTES', 'GRAPHQL_MAX_TOKENS', 'GRAPHQL_MAX_SELECTIONS']) {
      expect(() => readGraphqlAdmissionConfig({ [name]: v })).toThrow(new RegExp(`^${name} must be a positive integer`));
    }
  });

  it('createServer itself refuses boot, and the refusal does not echo the value', async () => {
    process.env.GRAPHQL_MAX_TOKENS = 'SENTINEL_BAD';
    try {
      const err: Error | null = await createServer().then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/GRAPHQL_MAX_TOKENS must be a positive integer/);
      expect(err?.message).not.toContain('SENTINEL_BAD');
    } finally { delete process.env.GRAPHQL_MAX_TOKENS; }
  });

  it('unset variables take the ruled defaults', () => {
    expect(readGraphqlAdmissionConfig({})).toEqual({ maxQueryBytes: 32768, maxTokens: 4000, maxSelections: 1000 });
  });
});
