/**
 * #4998 (entity refs S7): no NEW Query or Mutation argument names an entity by `id` / `<entity>Id` / `<entity>Ids`.
 *
 * `resolvers.refArgSchema.test.ts` checks only the fields its tables list, so a new mutation taking `fooId` passed every
 * check. This walk covers EVERY argument of every Query and Mutation field: one named `id`, `*Id` or `*Ids` fails unless
 * `ALLOWED_ID_ARGS` lists it with a one-line reason. hrn:node:hadronmemory.com:specs:cor:api:140:01: the name is the
 * contract; an argument that names an addressable entity is `<entity>Ref` (PK or URN), and `<entity>Id` is reserved for a
 * genuine primary key.
 *
 * The allow-list started as exactly what was on main after S0-S6 (main 6267f067b) and only shrinks: an entry with no
 * reason fails, and an entry whose argument no longer exists fails, so a rename removes its entry. Each reason is one of:
 *   - the entity has no ref resolver (#775's N/A list), so its primary key is the only address;
 *   - an external-system label or a token, not a Hadron entity;
 *   - a compare-and-set or legacy shape that takes only a PK on purpose;
 *   - a DEFERRAL: the entity has a resolver and the argument is a known gap, with its issue number.
 * Input-type fields are #5080's walk (`refArgSchema.test.ts`); `String`-typed ref arguments that exist today are accepted
 * (Holger R5, 2026-11-23), so this guard fixes the shape for new arguments only.
 */
import { describe, expect, it } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

/** `Query.<field>.<arg>` or `Mutation.<field>.<arg>` -> why it stays `id`/`*Id`/`*Ids`. */
export const ALLOWED_ID_ARGS: Record<string, string> = {};

/** The argument names this guard holds to the convention: a bare `id`, and any `…Id` or `…Ids`. */
export const ID_ARG = /^(id|.*Ids?)$/;

const CONVENTION = 'an argument naming an entity takes <entity>Ref (hrn:node:hadronmemory.com:specs:cor:api:140:01)';

/** Every unlisted id argument, every allow-list entry with no reason, and every stale entry. Empty = the schema conforms. */
export function idArgProblems(sdl: string = typeDefs, allowed: Record<string, string> = ALLOWED_ID_ARGS): string[] {
  const schema = buildSchema(sdl);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const root of [schema.getQueryType(), schema.getMutationType()]) {
    if (!root) continue;
    for (const [field, def] of Object.entries((root as GraphQLObjectType).getFields())) {
      for (const arg of def.args) {
        const key = `${root.name}.${field}.${arg.name}`;
        seen.add(key);
        if (ID_ARG.test(arg.name) && !(key in allowed)) {
          problems.push(`${key}: ${CONVENTION}; list it in ALLOWED_ID_ARGS with a one-line reason if it is a genuine primary key`);
        }
      }
    }
  }
  for (const [key, reason] of Object.entries(allowed)) {
    if (reason.trim() === '') problems.push(`${key}: allow-list entry has no reason (cor:api:140:01)`);
    if (!seen.has(key)) problems.push(`${key}: stale allow-list entry, no such argument (cor:api:140:01)`);
  }
  return problems;
}

describe('#4998 — no Query or Mutation argument names an entity by id unless allow-listed with a reason', () => {
  it('the real schema conforms', () => {
    expect(idArgProblems()).toEqual([]);
  });
  it('every allow-list entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWED_ID_ARGS)) expect(reason.trim(), key).not.toBe('');
  });
});

/** A fixture schema (never the real SDL), so the negative cases pin the CHECKER and not today's drift. */
const FIXTURE_SDL = `
  type Query { thing(ref: ID!, filterId: ID): String  list(memberIds: [ID!], limit: Int): String  byId(id: ID!): String }
  type Mutation { change(ref: ID!, fooId: ID): String  plain(name: String, fooRef: ID): String }
`;

describe('#4998 — the walk fails where it must (fixture schema)', () => {
  it('a new fooId mutation argument fails, naming the field, the argument and the convention', () => {
    const problems = idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Mutation\.change\.fooId: /);
    expect(problems[0]).toContain('cor:api:140:01');
  });
  it('adding it with a reason passes', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
    })).toEqual([]);
  });
  it('Query fields are walked, and id, *Id and *Ids all match; Ref and plain arguments do not', () => {
    expect(idArgProblems(FIXTURE_SDL, {}).map((p) => p.split(':')[0])).toEqual([
      'Query.thing.filterId', 'Query.list.memberIds', 'Query.byId.id', 'Mutation.change.fooId',
    ]);
  });
  it('an allow-list entry with an empty reason fails', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': ' ', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
    })).toEqual(['Query.thing.filterId: allow-list entry has no reason (cor:api:140:01)']);
  });
  it('an entry for an argument that does not exist fails (the list only shrinks)', () => {
    expect(idArgProblems(FIXTURE_SDL, {
      'Query.thing.filterId': 'a pk', 'Query.list.memberIds': 'a pk', 'Query.byId.id': 'a pk', 'Mutation.change.fooId': 'a pk',
      'Mutation.gone.oldId': 'renamed',
    })).toEqual(['Mutation.gone.oldId: stale allow-list entry, no such argument (cor:api:140:01)']);
  });
  it('an allowance is per root, field and argument: it covers neither another field nor the other root', () => {
    const sdl = 'type Query { a(xId: ID): String  b(xId: ID): String } type Mutation { a(xId: ID): String }';
    expect(idArgProblems(sdl, { 'Query.a.xId': 'a pk' }).map((p) => p.split(':')[0])).toEqual(['Query.b.xId', 'Mutation.a.xId']);
  });
});
