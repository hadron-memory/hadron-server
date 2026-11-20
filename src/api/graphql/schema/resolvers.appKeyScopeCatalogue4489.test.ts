/**
 * #4489 — the closed App key scope list as data (hrn:node:hadronmemory.com:specs:cor:aut:010:03).
 * Pins: the catalogue matches the closed list one for one and states the hostId rule; the rule agrees with the grant's own
 * hostId check; any signed-in caller (person or App key) may read it and nobody anonymous.
 */
import { describe, it, expect } from 'vitest';
import { buildSchema } from 'graphql';
import { resolvers, type Context } from './resolvers.js';
import { checkHostArg } from './resolvers.appKeyScope.js';
import { typeDefs } from './typeDefs.js';
import { APP_KEY_SCOPES } from '../../../lib/appKeyScopes/scopes.js';

const Q = resolvers.Query as any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db: {}, roles: ['READER'], ...extra }) as unknown as Context;

describe('appKeyScopeCatalogue (#4489)', () => {
  it('lists every scope of the closed list, once, in order, with a description and the hostId rule', async () => {
    const rows = await Q.appKeyScopeCatalogue(null, {}, ctx({ userId: 'u1' }));
    expect(rows.map((r: any) => r.scope)).toEqual([...APP_KEY_SCOPES]);
    for (const r of rows) expect(r.description.length).toBeGreaterThan(10);
    expect(Object.fromEntries(rows.map((r: any) => [r.scope, r.requiresHostId]))).toEqual({
      'attention:deliver': false,
      'host:operate': true,
    });
  });

  it('is readable by an App key as well as a person', async () => {
    const rows = await Q.appKeyScopeCatalogue(null, {}, ctx({ appKeyId: 'k1', appId: 'a1' }));
    expect(rows).toHaveLength(APP_KEY_SCOPES.length);
  });

  it('refuses an anonymous caller UNAUTHENTICATED', async () => {
    await expect(Q.appKeyScopeCatalogue(null, {}, ctx())).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });

  it('is in the SDL as a non-null list of non-null rows', () => {
    const field = buildSchema(typeDefs).getQueryType()!.getFields().appKeyScopeCatalogue;
    expect(String(field.type)).toBe('[AppKeyScopeInfo!]!');
  });

  it('every row agrees with the rule grantAppKeyScope enforces on hostId', async () => {
    const rows = await Q.appKeyScopeCatalogue(null, {}, ctx({ userId: 'u1' }));
    for (const r of rows) {
      const withHost = () => checkHostArg(r.scope, 'orca1');
      const without = () => checkHostArg(r.scope, null);
      if (r.requiresHostId) {
        expect(withHost).not.toThrow();
        expect(without).toThrow(/hostId/);
      } else {
        expect(without).not.toThrow();
        expect(withHost).toThrow(/send no hostId/);
      }
    }
  });
});
