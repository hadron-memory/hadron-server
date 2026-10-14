import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, graphql, printSchema } from 'graphql';
import { deploymentSchema } from './deploymentSchema.js';
import { signingSurfacePolicy } from '../../../lib/signing/surface.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

const fields = ['requestNodeSignature', 'withdrawSigningRequest', 'signingRequest', 'signatureStatus', 'signingRequests'];
const tools = ['hadron_request_signature', 'hadron_get_signing_request', 'hadron_withdraw_signing_request'];
afterEach(() => vi.unstubAllEnvs());

describe('#1895 off-state discovery and execution', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', ' true ', 'malformed'])('registration fails closed for %s with signing on', value => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', value);
    expect(signingSurfacePolicy()).toEqual({ signing: true, registration: false });
  });
  it.each([undefined, '', 'false', 'TRUE', '1', ' true ', 'malformed'])('fails closed for signing=%s', async value => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', value);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
    expect(signingSurfacePolicy()).toEqual({ signing: false, registration: false });
    const surface = deploymentSchema();
    const schema = buildSchema(surface.typeDefs);
    const sdl = printSchema(schema);
    for (const name of [...fields, 'SigningRequest', 'NodeSignature', 'SigningRequester', 'SignatureState']) {
      expect(sdl).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    const result = await graphql({ schema, source: '{ signingRequest(id:"opaque") { id } }' });
    expect(result.errors?.[0].message).toBe('Cannot query field "signingRequest" on type "Query".');
    expect(surface.resolvers.Query).not.toHaveProperty('signingRequest');
    expect(surface.resolvers.Mutation).not.toHaveProperty('requestNodeSignature');
    expect(surface.resolvers.Mutation).not.toHaveProperty('withdrawSigningRequest');
    expect(surface.resolvers.Node).not.toHaveProperty('signatureStatus');
    expect(surface.resolvers.Node).not.toHaveProperty('signingRequests');
    const mcp = createTestableMcpServer({ roles: [] });
    for (const name of tools) {
      expect(mcp.toolNames()).not.toContain(name);
      await expect(mcp.callToolText(name, {})).rejects.toThrow(`Tool not registered: ${name}`);
    }
  });

  it('opt-in restores schema and all three tools while registration remains separately off', () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', undefined);
    expect(signingSurfacePolicy()).toEqual({ signing: true, registration: false });
    const schema = buildSchema(deploymentSchema().typeDefs);
    expect(schema.getQueryType()?.getFields()).toHaveProperty('signingRequest');
    expect(schema.getMutationType()?.getFields()).toHaveProperty('requestNodeSignature');
    const mcp = createTestableMcpServer({ roles: [] });
    expect(mcp.toolNames()).toEqual(expect.arrayContaining(tools));
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
    expect(signingSurfacePolicy()).toEqual({ signing: true, registration: true });
  });
});
