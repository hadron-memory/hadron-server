/**
 * #85 (cor:api:140:02 r7): a mutation called with no user and no App refuses UNAUTHENTICATED before it resolves any
 * App or organization reference, so a real ref, a soft-deleted one, a missing one and a malformed one all get the same
 * answer. Signed-in and App-key answers are unchanged.
 *
 * ONE chokepoint, derived from the schema: a mutation is a "ref door" when one of its arguments (or a field of an input
 * object argument, at any depth) is an App or organization reference by name (`appRef`, `orgRef`, `appId`, `orgId`, ...)
 * or is on the short irregular list below. A hand-kept per-resolver list drifts (#49), so a new door with a conforming
 * argument name is covered without anyone remembering it; the test pins the derived list.
 */
import { GraphQLError, getNamedType, isInputObjectType } from 'graphql';
import type { GraphQLArgument, GraphQLInputType, GraphQLSchema, OperationDefinitionNode } from 'graphql';
import type { ApolloServerPlugin } from '@apollo/server';
import { topLevelFieldNames, fragmentMap } from './impersonationReadOnlyPlugin.js';

/** Argument names that mean an App or organization reference. */
const REF_ARG_NAME = /^(app|org|organization)(Ref|Id|Urn|Slug)$/i;
/** Door-specific names that are not shaped like the pattern above (`field` -> argument names). */
const IRREGULAR: Readonly<Record<string, readonly string[]>> = {
  updateOrganization: ['ref'],
  deleteOrganization: ['ref'],
};

function inputHasRefField(type: GraphQLInputType, seen: Set<string>, depth = 0): boolean {
  const named = getNamedType(type);
  if (!isInputObjectType(named) || seen.has(named.name) || depth > 8) return false;
  seen.add(named.name);
  return Object.values(named.getFields()).some(
    (f) => REF_ARG_NAME.test(f.name) || inputHasRefField(f.type, seen, depth + 1),
  );
}

function isRefArg(field: string, arg: GraphQLArgument): boolean {
  return REF_ARG_NAME.test(arg.name)
    || (IRREGULAR[field]?.includes(arg.name) ?? false)
    || inputHasRefField(arg.type, new Set());
}

/** The mutation fields that take an App or organization reference, derived from the schema. */
export function signedOutRefDoors(schema: GraphQLSchema): string[] {
  const mutation = schema.getMutationType();
  if (!mutation) return [];
  return Object.values(mutation.getFields())
    .filter((f) => f.args.some((a) => isRefArg(f.name, a)))
    .map((f) => f.name)
    .sort();
}

const cache = new WeakMap<GraphQLSchema, Set<string>>();
function doorSet(schema: GraphQLSchema): Set<string> {
  let set = cache.get(schema);
  if (!set) cache.set(schema, (set = new Set(signedOutRefDoors(schema))));
  return set;
}

export const signedOutRefDoorsPlugin: ApolloServerPlugin<{ userId?: string; appId?: string; appKeyId?: string }> = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, document, contextValue, schema }) {
        if (contextValue.userId || contextValue.appId || contextValue.appKeyId) return;
        const op = operation as OperationDefinitionNode | undefined;
        if (!op || op.operation !== 'mutation') return;
        const fields = topLevelFieldNames(op.selectionSet, fragmentMap(document));
        const doors = doorSet(schema);
        // null: the selection set cannot be enumerated, so it cannot be proven free of a ref door. Refuse.
        if (fields === null || fields.some((f) => doors.has(f))) {
          throw new GraphQLError('Authenticated user required', { extensions: { code: 'UNAUTHENTICATED' } });
        }
      },
    };
  },
};
