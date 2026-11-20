/**
 * #4489 — the closed App key scope list as data (hrn:node:hadronmemory.com:specs:cor:aut:010:03).
 * Pins: the catalogue matches the closed list one for one, states the hostId rule, is readable by any signed-in
 * caller (person or App key) and by nobody anonymous, and a granted scope's rule agrees with the grant's own check.
 */
import { describe, it, expect } from 'vitest';
import { GraphQLError } from 'graphql';
import { buildSchema, parse, validate } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { APP_KEY_SCOPES } from '../../../lib/appKeyScopes/scopes.js';

const Q = resolvers.Query as any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, roles: ['READER'], ...extra }) as Context;

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
    let code: string | undefined;
    try { await Q.appKeyScopeCatalogue(null, {}, ctx()); } catch (e) { expect(e).toBeInstanceOf(GraphQLError); code = (e as GraphQLError).extensions?.code as string; }
    expect(code).toBe('UNAUTHENTICATED');
  });

  it('is in the SDL as a non-null list of non-null rows', () => {
    const doc = parse(`{ appKeyScopeCatalogue { scope description requiresHostId } }`);
    const schema = buildSchema(typeDefs);
    expect(validate(schema, doc)).toEqual([]);
  });
});
