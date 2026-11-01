/**
 * #1632 S2b-2 (cor:dmo:130:08, hrn:node:hadronmemory.com:specs:cor:dmo:130:02) — the link a request hands over,
 * and the rule that no GraphQL or MCP call ever takes an assertion.
 *
 * `SigningRequest.ceremonyUrl` is `<server origin>/signing/<requestId>`: the id is the only path parameter and
 * there is no token, query or fragment. The CLI, portal and MCP copy it verbatim and never compose one.
 */
import { buildSchema, isInputObjectType, isObjectType, type GraphQLField } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

const as = (userId: string): Context => ({ db, userId, roles: [] });
const R = (resolvers as unknown as { SigningRequest: Record<string, (r: unknown, a: unknown, c: Context) => unknown> }).SigningRequest;

let admin: { id: string };
let reader: { id: string };
let memory: { id: string; urn: string };

beforeEach(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('BASE_URL', 'https://hadron.example.test');
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Link Org', urn: 'link-org.example' } });
  admin = await db.user.create({ data: { githubId: 163601, githubUsername: 'lk-admin', handle: 'lk-admin', roles: [] } });
  reader = await db.user.create({ data: { githubId: 163602, githubUsername: 'lk-reader', handle: 'lk-reader', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'links' }, as(admin.id)) as typeof memory;
  await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'l:1', name: 'One', content: 'Body' } });
});
afterEach(() => vi.unstubAllEnvs());

describe('SigningRequest.ceremonyUrl', () => {
  it('is declared String! in the SDL, citing the rule', () => {
    const f = (buildSchema(typeDefs).getType('SigningRequest') as import('graphql').GraphQLObjectType).getFields().ceremonyUrl;
    expect(f, 'ceremonyUrl is on SigningRequest').toBeDefined();
    expect(String(f.type)).toBe('String!');
    expect(f.description).toContain('hrn:node:hadronmemory.com:specs:cor:dmo:130:08');
  });

  it('is the server origin plus /signing/<id>, and nothing else', async () => {
    const req = await resolvers.Mutation.requestNodeSignature(null, { nodeRef: `hrn:node:${memory.urn}:l:1` }, as(reader.id)) as { id: string };
    const url = R.ceremonyUrl(req, {}, as(reader.id)) as string;
    expect(url).toBe(`https://hadron.example.test/signing/${req.id}`);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/signing/${req.id}`);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(parsed.username + parsed.password).toBe('');
  });

  it('is returned for an ended request too (the link stays a handle; the page refuses it)', async () => {
    const req = await resolvers.Mutation.requestNodeSignature(null, { nodeRef: `hrn:node:${memory.urn}:l:1` }, as(reader.id)) as { id: string };
    await resolvers.Mutation.withdrawSigningRequest(null, { id: req.id }, as(reader.id));
    const row = await db.signingRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(R.ceremonyUrl(row, {}, as(reader.id))).toBe(`https://hadron.example.test/signing/${req.id}`);
  });
});

describe('MCP hands over the link and still signs nothing', () => {
  const mcpAs = (userId: string) => createTestableMcpServer({ userId, roles: [], clientId: `user:${userId}` });

  it('hadron_request_signature and hadron_get_signing_request print the link of an open request', async () => {
    const mcp = mcpAs(reader.id);
    const created = await mcp.callToolText('hadron_request_signature', { nodeRef: `hrn:node:${memory.urn}:l:1` });
    const id = /Signing request (\S+)/.exec(created)![1];
    expect(created).toContain(`Ceremony link: https://hadron.example.test/signing/${id}`);
    expect(created).toMatch(/no agent can complete this request/);
    expect(await mcp.callToolText('hadron_get_signing_request', { id })).toContain(`Ceremony link: https://hadron.example.test/signing/${id}`);
  });

  it('prints no link once the request has ended: there is nothing to open', async () => {
    const mcp = mcpAs(reader.id);
    const id = /Signing request (\S+)/.exec(await mcp.callToolText('hadron_request_signature', { nodeRef: `hrn:node:${memory.urn}:l:1` }))![1];
    const withdrawn = await mcp.callToolText('hadron_withdraw_signing_request', { id });
    expect(withdrawn).toMatch(/State: withdrawn/);
    expect(withdrawn).not.toMatch(/Ceremony link/);
    expect(await mcp.callToolText('hadron_get_signing_request', { id })).not.toMatch(/Ceremony link/);
  });
});

describe('no GraphQL or MCP call takes an assertion or a signature record (cor:dmo:130:02 S2)', () => {
  const ASSERTION_WORDS = /assertion|authenticator|clientdata|signature(?!status)|credentialid|webauthn|passkey/i;

  it('signing mutations and queries accept only refs, ids and an expected revision', () => {
    const schema = buildSchema(typeDefs);
    const mutation = schema.getMutationType()!.getFields();
    const query = schema.getQueryType()!.getFields();
    const signingOps: Array<GraphQLField<unknown, unknown>> = [
      mutation.requestNodeSignature, mutation.withdrawSigningRequest, query.signingRequest,
    ];
    for (const op of signingOps) {
      expect(op).toBeDefined();
      for (const arg of op.args) {
        expect(arg.name, `${op.name}(${arg.name})`).not.toMatch(ASSERTION_WORDS);
        const named = String(arg.type).replace(/[![\]]/g, '');
        const t = schema.getType(named);
        if (t && isInputObjectType(t)) for (const k of Object.keys(t.getFields())) expect(k).not.toMatch(ASSERTION_WORDS);
      }
    }
    // And nothing in the whole mutation surface is named for completing or storing a signature.
    const writes = Object.keys(mutation).filter((n) => /signature|signing/i.test(n));
    expect(writes.sort()).toEqual(['requestNodeSignature', 'withdrawSigningRequest']);
    const objs = Object.values(schema.getTypeMap()).filter((t) => isObjectType(t) && /^Signing/.test(t.name));
    expect(objs.length).toBeGreaterThan(0);
  });

  it('the MCP signing tools take no assertion either', () => {
    const srv = createTestableMcpServer({ userId: reader.id, roles: [], clientId: `user:${reader.id}` });
    const tools = srv.toolNames().filter((n) => /signature|signing/.test(n));
    expect(tools.sort()).toEqual(['hadron_get_signing_request', 'hadron_request_signature', 'hadron_withdraw_signing_request']);
    // Probe by name: a parameter that could carry an assertion or a record must not exist on any of them.
    const forbidden = ['assertion', 'signature', 'authenticatorData', 'clientDataJson', 'clientDataJSON', 'credentialId', 'credential', 'response', 'record', 'webauthn', 'passkey'];
    for (const t of tools) for (const k of forbidden) expect(() => srv.toolParamSchema(t, k), `${t}.${k}`).toThrow(/no parameter/);
    // The probe can fail: a real parameter is found.
    expect(() => srv.toolParamSchema('hadron_request_signature', 'nodeRef')).not.toThrow();
  });
});
