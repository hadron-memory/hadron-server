import { describe, expect, it, vi } from 'vitest';
import { graphql, buildSchema } from 'graphql';
import { parseTeamSpec } from './parse.js';
import { canonicalizeTeamJson } from './canonicalize.js';
import { publishedTeamSpecSchema, publishedTeamSpecSchemaText, TEAM_API_VERSION, validateTeamSpec } from './schema.js';
import { teamSpecQueries } from '../../api/graphql/schema/resolvers.teamSpec.js';
import express from 'express';
import { once } from 'node:events';
import { mountTeamSpecSchemaRoutes } from '../../api/teamSpecSchema.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const spec = () => ({
  apiVersion: TEAM_API_VERSION, kind: 'Team', metadata: { app: 'app-id', org: 'example.org' },
  spec: { roles: { engineer: { title: 'Engineer', prompt: { parts: [{ text: 'a\r\nb' }, { node: 'node-id', revision: 2, sha256: 'a'.repeat(64) }] } } },
    workers: [{ name: 'Milo', role: 'engineer' }] },
});
const errors = (run: () => unknown) => {
  try { run(); throw new Error('Expected refusal'); }
  catch (error) { return (error as { extensions: Record<string, unknown> }).extensions; }
};

describe('team schema S1', () => {
  it('preserves prompt bytes and override omission/null/empty semantics', () => {
    const value = spec();
    const parsed = parseTeamSpec(JSON.stringify(value));
    expect(parsed).toEqual(value);
    expect(Object.hasOwn(parsed.spec.workers[0], 'override')).toBe(false);
    for (const override of [null, '', 'briefing']) {
      const changed = { ...value, spec: { ...value.spec, workers: [{ ...value.spec.workers[0], override }] } };
      expect(parseTeamSpec(JSON.stringify(changed)).spec.workers[0].override).toBe(override);
    }
  });
  it('refuses shared-agent opt-ins, fork and removal fields under AM', () => {
    for (const patch of [{ sharedAgent: 'refuse' }, { sharedAgent: 'update' }, { sharedAgent: 'fork' }, { installed: false }, { state: 'retired' }]) {
      const value = spec();
      Object.assign(value.spec.roles.engineer, patch);
      expect(errors(() => validateTeamSpec(value)).code).toBe('TEAM_SPEC_INVALID');
    }
  });
  it('publishes separate file-capable client and server schemas', () => {
    const value = spec();
    (value.spec.roles.engineer.prompt.parts as unknown[]) = [{ file: 'roles/engineer.md' }];
    expect(errors(() => parseTeamSpec(JSON.stringify(value))).code).toBe('TEAM_SPEC_INVALID');
    expect(validateTeamSpec(value, 'CLIENT_INPUT')).toEqual(value);
    const server = JSON.stringify(publishedTeamSpecSchema(TEAM_API_VERSION));
    const client = JSON.stringify(publishedTeamSpecSchema(TEAM_API_VERSION, 'CLIENT_INPUT'));
    expect(server).not.toContain('"file"'); expect(client).toContain('"file"');
    expect(JSON.parse(server).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });
  it('#1675 carry: cached public text preserves the CLIENT_INPUT/SERVER distinction', async () => {
    const server = publishedTeamSpecSchemaText(TEAM_API_VERSION, 'SERVER');
    const client = publishedTeamSpecSchemaText(TEAM_API_VERSION, 'CLIENT_INPUT');
    expect(server).not.toContain('"file"');
    expect(client).toContain('"file"');
    expect(client).not.toBe(server);
    const schema = buildSchema(typeDefs);
    const result = await graphql({ schema, source: 'query($v:String!){server:teamSpecSchema(apiVersion:$v,form:SERVER) client:teamSpecSchema(apiVersion:$v,form:CLIENT_INPUT)}',
      variableValues: { v: TEAM_API_VERSION }, rootValue: { teamSpecSchema: (args: { apiVersion: string; form: 'SERVER' | 'CLIENT_INPUT' }) => teamSpecQueries.teamSpecSchema(null, args) } });
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({ server, client });
  });
  it('pins the nesting boundary and value refusal codes separately from shape errors', () => {
    // The envelope itself has shallower nesting; annotation text may contain
    // JSON-looking text without contributing to JSON nesting.
    const tooDeep = '['.repeat(101) + '0' + ']'.repeat(101);
    expect(errors(() => parseTeamSpec(tooDeep)).issues).toEqual([
      expect.objectContaining({ code: 'INVALID_JSON', message: 'JSON nesting is too deep' }),
    ]);
    const atBoundary = '['.repeat(100) + '0' + ']'.repeat(100);
    expect(errors(() => parseTeamSpec(atBoundary)).issues).not.toEqual([
      expect.objectContaining({ message: 'JSON nesting is too deep' }),
    ]);
    for (const input of ['{"x":1e400}', '{"x":"\\ud800"}']) {
      expect(errors(() => parseTeamSpec(input)).issues).toEqual([
        expect.objectContaining({ code: 'INVALID_JSON_VALUE' }),
      ]);
    }
  });
  it('refuses unknown root fields instead of stripping them', () => {
    expect(errors(() => parseTeamSpec(JSON.stringify({ ...spec(), extra: true }))).issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', pointer: '' }),
    ]);
  });
  it('scans long scalar sequences from the original input without suffix copies', () => {
    // Syntactically valid JSON, then refused for its extra root field. The
    // scanner must finish without copying the full remaining input per token.
    const text = JSON.stringify({ ...spec(), extra: Array.from({ length: 5000 }, (_, i) => i) });
    const original = String.prototype.slice;
    let suffixCopies = 0;
    const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (this: string, start?: number, end?: number) {
      if (String(this) === text && start !== 0 && end === undefined) suffixCopies++;
      return original.call(this, start, end);
    });
    try {
      expect(errors(() => parseTeamSpec(text)).code).toBe('TEAM_SPEC_INVALID');
      expect(suffixCopies).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('reports worker collisions and unknown roles together with pointers', () => {
    const value = spec(); value.spec.workers.push({ name: ' milo ', role: 'missing' });
    expect(errors(() => validateTeamSpec(value)).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ pointer: '/spec/workers/1/name', code: 'TEAM_SPEC_DUPLICATE_WORKER' }),
      expect.objectContaining({ pointer: '/spec/workers/1/role', code: 'TEAM_SPEC_UNKNOWN_ROLE' }),
    ]));
  });
  it('rejects duplicate keys including escaped spellings before JSON.parse loses them', () => {
    for (const text of ['{"metadata":{"app":"a","app":"b"}}', '{"metadata":{"app":"a","\\u0061pp":"b"}}']) {
      expect(errors(() => parseTeamSpec(text)).issues).toEqual([
        expect.objectContaining({ pointer: '/metadata/app', code: 'DUPLICATE_KEY', line: 1 }),
      ]);
    }
    expect(errors(() => parseTeamSpec('{\n"x": 1, "x":2}')).issues).toEqual([
      expect.objectContaining({ pointer: '/x', line: 2 }),
    ]);
  });
  it('rejects malformed JSON and unknown versions with a supported-version list', () => {
    for (const text of ['', '{"x":01}', '{"x":1,}', '[1,]', '{"x":"\\q"}', '{} extra', '{"x":1e999}', '{"x":"\\ud800"}']) {
      expect(errors(() => parseTeamSpec(text)).code).toBe('TEAM_SPEC_INVALID');
    }
    expect(errors(() => validateTeamSpec({ ...spec(), apiVersion: 'future' }))).toMatchObject({
      code: 'TEAM_SPEC_VERSION_UNSUPPORTED', accepted: [TEAM_API_VERSION],
    });
  });
  it('requires exactly one role source and strict nested keys', () => {
    const value = spec();
    Object.assign(value.spec.roles.engineer, { agent: 'agent-id' });
    expect(errors(() => validateTeamSpec(value)).code).toBe('TEAM_SPEC_INVALID');
    const adopted = { ...spec(), spec: { roles: { engineer: { agent: 'agent-id', resolved: { adopt: 'agent-id' } } }, workers: [] } };
    expect(validateTeamSpec(adopted)).toEqual(adopted);
  });
  it('requires a revision when a source digest is supplied', () => {
    const value = spec(); delete value.spec.roles.engineer.prompt.parts[1].revision;
    expect(errors(() => validateTeamSpec(value)).issues).toEqual([
      expect.objectContaining({ pointer: '/spec/roles/engineer/prompt/parts/1/sha256' }),
    ]);
  });
  it('canonicalizes with ECMAScript numeric forms and UTF-16 key ordering', () => {
    expect(canonicalizeTeamJson({ '\ufffd': 1, '\ud83d\ude00': 2, a: [1e30, 0.000001, -0] }))
      .toBe('{"a":[1e+30,0.000001,0],"😀":2,"�":1}');
    expect(canonicalizeTeamJson({ b: 'e\u0301\r\n', a: null })).toBe('{"a":null,"b":"é\\r\\n"}');
    expect(canonicalizeTeamJson(spec())).toBe(canonicalizeTeamJson(JSON.parse(JSON.stringify(spec()))));
    for (const value of [Infinity, '\ud800', { a: undefined }]) expect(() => canonicalizeTeamJson(value)).toThrow();
  });
  it('exposes discovery through the GraphQL wire with nullable form defaulting', async () => {
    const schema = buildSchema(typeDefs);
    const result = await graphql({ schema, source: 'query($v:String!){teamSpecSchema(apiVersion:$v,form:null)}',
      variableValues: { v: TEAM_API_VERSION }, rootValue: { teamSpecSchema: (args: { apiVersion: string; form: null }) => teamSpecQueries.teamSpecSchema(null, args) } });
    expect(result.errors).toBeUndefined();
    expect(JSON.parse(result.data!.teamSpecSchema as string)).toEqual(publishedTeamSpecSchema(TEAM_API_VERSION));
  });
  it('keeps arbitrary annotation keys without losing JSON data', () => {
    const input = spec();
    Object.assign(input.metadata, { annotations: JSON.parse('{"__proto__":"note","constructor":"note"}') });
    expect(parseTeamSpec(JSON.stringify(input))).toEqual(input);
  });
  it('validates every preserved record entry, including __proto__', () => {
    for (const annotation of [17, null, { note: 'not a string' }]) {
      const input = spec();
      Object.assign(input.metadata, { annotations: JSON.parse(JSON.stringify({ ['__proto__']: annotation })) });
      expect(errors(() => parseTeamSpec(JSON.stringify(input))).issues).toEqual([
        expect.objectContaining({ pointer: '/metadata/annotations/__proto__' }),
      ]);
    }
    const input = spec();
    // Construct the original JSON record directly, as the server receives it.
    input.spec.roles = JSON.parse('{"__proto__":null}');
    expect(errors(() => parseTeamSpec(JSON.stringify(input))).code).toBe('TEAM_SPEC_INVALID');
  });
  it('serves versioned discovery and refuses unknown versions over HTTP', async () => {
    const app = express(); mountTeamSpecSchemaRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/schemas/team/v1alpha1.json`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(publishedTeamSpecSchema(TEAM_API_VERSION));
      const missing = await fetch(`http://127.0.0.1:${address.port}/schemas/team/future.json`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 'TEAM_SPEC_VERSION_UNSUPPORTED', accepted: ['v1alpha1.json'] });
    } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
  });
});
