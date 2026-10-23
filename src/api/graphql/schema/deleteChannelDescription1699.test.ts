/**
 * #1699 — `deleteChannel`'s SDL description must say what the server does.
 *
 * It used to promise "a restore brings both back". No restore exists
 * (cor:dmo:090:03: a deleted address is reusable and its successor starts
 * clean, #1257 / #1226), so a client reading the schema was told about a
 * recovery path that is not there. The description is served to clients
 * through introspection, so it is pinned through the built schema.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

function deleteChannelDescription(): string {
  const mutation = buildSchema(typeDefs).getType('Mutation');
  if (!(mutation instanceof GraphQLObjectType)) throw new Error('Mutation type missing');
  return mutation.getFields().deleteChannel?.description ?? '';
}

describe('deleteChannel description (#1699)', () => {
  it('does not promise a restore, and there is no restore mutation to promise', () => {
    expect(deleteChannelDescription()).not.toMatch(/restore/i);
    const mutation = buildSchema(typeDefs).getType('Mutation') as GraphQLObjectType;
    expect(Object.keys(mutation.getFields()).filter(n => /^(restore|undelete)Channel/i.test(n))).toEqual([]);
  });

  it('says a Channel created at the same address adopts it and starts clean', () => {
    const text = deleteChannelDescription().replace(/\s+/g, ' ');
    expect(text).toContain('creating a Channel at the same address adopts it and starts clean');
    expect(text).toContain('#1257');
    expect(text).toContain('#1226');
  });
});
