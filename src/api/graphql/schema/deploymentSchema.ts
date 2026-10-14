import { Kind, parse, print, visit } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { signingSurfacePolicy } from '../../../lib/signing/surface.js';

const signingTypes = new Set([
  'SigningRequestState', 'SignatureState', 'SigningRequester',
  'SigningRequest', 'NodeSignature', 'NodeSignatureStatus',
]);

/** #1895: Apollo execution, introspection and SDL discovery share this schema.
 * Remove the feature before validation, rather than inventing an off-state
 * error that differs from an absent field. Deployment switches require restart.
 */
export function deploymentSchema() {
  if (signingSurfacePolicy().signing) return { typeDefs, resolvers };
  const removedFields = new Map<string, Set<string>>();
  const document = visit(parse(typeDefs), {
    enter(node, _key, parent, _path, ancestors) {
      if ('name' in node && node.name && node.kind !== Kind.FIELD_DEFINITION && signingTypes.has(node.name.value)) return null;
      if (node.kind !== Kind.FIELD_DEFINITION) return;
      let type = node.type;
      while (type.kind !== Kind.NAMED_TYPE) type = type.type;
      if (!signingTypes.has(type.name.value)) return;
      const owner = [...ancestors, parent].reverse().find(item => item && !Array.isArray(item) && 'kind' in item && item.kind === Kind.OBJECT_TYPE_DEFINITION);
      if (owner && !Array.isArray(owner) && 'name' in owner && owner.name) {
        const fields = removedFields.get(owner.name.value) ?? new Set<string>();
        fields.add(node.name.value);
        removedFields.set(owner.name.value, fields);
      }
      return null;
    },
  });
  const filtered = Object.fromEntries(Object.entries(resolvers)
    .filter(([name]) => !signingTypes.has(name))
    .map(([name, fields]) => [name, removedFields.has(name)
      ? Object.fromEntries(Object.entries(fields).filter(([field]) => !removedFields.get(name)!.has(field)))
      : fields]));
  return { typeDefs: print(document), resolvers: filtered as unknown as typeof resolvers };
}
