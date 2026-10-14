import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, graphql } from 'graphql';
import { getDeploymentInfo } from './deploymentInfo.js';
import { createTestableMcpServer } from './server.js';
import { capabilityFields, deploymentSchema } from '../api/graphql/schema/deploymentSchema.js';

afterEach(() => vi.unstubAllEnvs());
const matrix: Array<[string | undefined, string | undefined, boolean, boolean]> = [
  [undefined, undefined, false, false], [undefined, 'true', false, false],
  ['false', 'true', false, false], ['TRUE', 'true', false, false],
  ['1', 'true', false, false], [' true ', 'true', false, false],
  ['malformed', 'true', false, false], ['true', undefined, true, false],
  ['true', 'false', true, false], ['true', 'TRUE', true, false],
  ['true', ' true ', true, false], ['true', 'true', true, true],
];

describe('#1900 on-state-only disclosure', () => {
  it('the visitor consumes the exported field map rather than an inline copy', () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    const map = capabilityFields.ServerInfo as Record<string, 'signing' | 'registration'>;
    const previous = map.passkeyRegistration;
    try {
      map.passkeyRegistration = 'signing';
      const fields = (buildSchema(deploymentSchema().typeDefs).getType('ServerInfo') as any).getFields();
      expect(fields).toHaveProperty('passkeyRegistration');
    } finally {
      map.passkeyRegistration = previous;
    }
  });
  it.each(matrix)('signing=%s registration=%s yields %s/%s in both surfaces', async (general, registration, signingOn, registrationOn) => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', undefined);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', undefined);
    const baseline = getDeploymentInfo();
    expect(Object.keys(baseline)).toEqual(['baseUrl', 'version']);
    const baselineText = await createTestableMcpServer({ roles: [] }).callToolText('hadron_server_info');
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', general);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', registration);
    const expected = { ...baseline, ...(signingOn ? { signing: true } : {}), ...(registrationOn ? { passkeyRegistration: true } : {}) };
    expect(getDeploymentInfo()).toEqual(expected);
    const text = await createTestableMcpServer({ roles: [] }).callToolText('hadron_server_info');
    const tokens = /^capabilities: (.*)$/m.exec(text)![1].split(', ');
    expect(tokens.includes('node-signing')).toBe(signingOn);
    expect(tokens.includes('passkey-registration')).toBe(registrationOn);
    if (!signingOn) {
      expect(JSON.stringify(getDeploymentInfo())).toBe(JSON.stringify(baseline));
      expect(text).toBe(baselineText);
    }
    const schema = buildSchema(deploymentSchema().typeDefs);
    const fields = (schema.getType('ServerInfo') as any).getFields();
    for (const [field, flag] of Object.entries(capabilityFields.ServerInfo)) {
      expect(field in fields).toBe(flag === 'signing' ? signingOn : registrationOn);
    }
    expect('signing' in fields).toBe(signingOn);
    expect('passkeyRegistration' in fields).toBe(registrationOn);
    const selected = `version baseUrl ${signingOn ? 'signing' : ''} ${registrationOn ? 'passkeyRegistration' : ''}`;
    const result = await graphql({ schema, source: `{ serverInfo { ${selected} } }`, rootValue: { serverInfo: getDeploymentInfo } });
    expect(result.errors).toBeUndefined();
    expect(result.data?.serverInfo).toEqual(expected);
    if (!signingOn) {
      const refusal = await graphql({ schema, source: '{serverInfo{signing}}' });
      expect(refusal.errors?.[0].message).toBe('Cannot query field "signing" on type "ServerInfo".');
    }
  });
});
