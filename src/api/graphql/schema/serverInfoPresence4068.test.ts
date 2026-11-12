import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { deploymentSchema } from './deploymentSchema.js';
import { serverInfoFieldPresence } from '../../../lib/signing/surface.js';
import { getDeploymentInfo } from '../../../mcp/deploymentInfo.js';

afterEach(() => vi.unstubAllEnvs());

/** #4068: the schema gate, the resolver's token and the revoke-URL check read ONE presence function. */
const matrix: Array<[string, string, { signing: boolean; passkeyRegistration: boolean; passkeyRevokeUrl: boolean }]> = [
  ['true', 'true', { signing: true, passkeyRegistration: true, passkeyRevokeUrl: true }],
  ['true', 'false', { signing: true, passkeyRegistration: false, passkeyRevokeUrl: false }],
  ['false', 'false', { signing: false, passkeyRegistration: false, passkeyRevokeUrl: false }],
  // Registration on with signing off: registration implies signing (cor:api:020:01), so BOTH are absent.
  ['false', 'true', { signing: false, passkeyRegistration: false, passkeyRevokeUrl: false }],
];

describe('#4068 ServerInfo presence is derived once', () => {
  it.each(matrix)('signing=%s registration=%s', (signing, registration, expected) => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', signing);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', registration);
    expect(serverInfoFieldPresence()).toEqual(expected);
    // Schema: exactly the present fields exist on ServerInfo.
    const type = buildSchema(deploymentSchema().typeDefs).getType('ServerInfo') as GraphQLObjectType;
    const sdlFields = Object.keys(type.getFields());
    for (const [field, present] of Object.entries(expected)) expect(sdlFields.includes(field), field).toBe(present);
    // Resolver side: the same tokens, none for an absent field (never false).
    const info = getDeploymentInfo();
    expect('signing' in info, 'signing token').toBe(expected.signing);
    expect('passkeyRegistration' in info, 'registration token').toBe(expected.passkeyRegistration);
    // No split: a schema field present with its resolver token absent (or the reverse) is the drift this prevents.
    expect(sdlFields.includes('signing')).toBe('signing' in info);
    expect(sdlFields.includes('passkeyRegistration')).toBe('passkeyRegistration' in info);
  });

  // The function encodes registration-implies-signing itself, not only through the env reader.
  it('a policy with registration on and signing off yields BOTH absent', () => {
    expect(serverInfoFieldPresence({ signing: false, registration: true })).toEqual({ signing: false, passkeyRegistration: false, passkeyRevokeUrl: false });
    expect(serverInfoFieldPresence({ signing: true, registration: true })).toEqual({ signing: true, passkeyRegistration: true, passkeyRevokeUrl: true });
  });
});
