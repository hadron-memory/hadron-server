/**
 * #789 — the SDL must declare the SAME argument names the resolvers
 * destructure, for every entity-reference argument on the agent/app write
 * surface (cor:api:140).
 *
 * This guard exists because that invariant is genuinely unguarded otherwise:
 * every other test in this repo calls `resolvers.Mutation.*` DIRECTLY, which
 * bypasses GraphQL argument validation entirely. So during #789 the resolver
 * for `createApp` was renamed to `agentRef` while its SDL still said
 * `agentId` — the whole suite stayed green, `tsc` was clean, and
 * `check-graphql-sdl` passed (it only parses). The mismatch surfaced only when
 * hadron-cli's genqlient codegen validated a real operation against the
 * exported schema. Any caller going through the actual GraphQL layer would
 * have hit "Unknown argument".
 *
 * Cheap to keep, and it fails loudly on exactly that drift.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';

/** The expected reference-argument names, per cor:api:140. */
const EXPECTED_REF_ARGS: Record<string, string[]> = {
  updateAgent: ['ref'],
  deleteAgent: ['ref'],
  repairAgentSystemMemory: ['agentRef'],
  addMemoryToAgent: ['agentRef', 'memoryRef'],
  updateAgentMemoryRole: ['agentRef', 'memoryRef'],
  removeMemoryFromAgent: ['agentRef', 'memoryRef'],
  updateApp: ['ref'],
  deleteApp: ['ref'],
  regenerateAppKey: ['appRef'],
  createAppKey: ['appRef'],
  createApp: ['orgRef', 'agentRef'],
  installAgentIntoApp: ['appRef', 'agentRef'],
  createTeamPersona: ['appRef', 'teamAgentRef'],
  createTeamChatMessage: ['appRef', 'sessionRef'],
  recordTeamWork: ['appRef', 'sessionRef'],
  uninstallAgentFromApp: ['appRef', 'agentRef'],
  addAgentToApp: ['appRef', 'agentRef'],
  removeAgentFromApp: ['appRef', 'agentRef'],
  publishAgentImport: ['parentAgentRef', 'importedAgentRef'],
  removeAgentImport: ['parentAgentRef', 'importedAgentRef'],
  startImpersonation: ['orgRef', 'userRef'],
  retryFailedEmbeddings: ['memoryRef'],
};

/**
 * Args that legitimately stay `<entity>Id` because they are genuine PKs, per
 * the convention ("output fields, DB columns, resolved locals" → `<entity>Id`).
 */
const ALLOWED_ID_ARGS = new Set(['systemMemoryId', 'userId']);

const mutationFields = () => {
  const schema = buildSchema(typeDefs);
  const mutation = schema.getType('Mutation') as GraphQLObjectType;
  return mutation.getFields();
};

describe('#789 — SDL ref-argument names match the resolvers', () => {
  const fields = mutationFields();

  it.each(Object.entries(EXPECTED_REF_ARGS))(
    '%s declares %s',
    (name, expected) => {
      const field = fields[name];
      expect(field, `Mutation.${name} is missing from the SDL`).toBeDefined();
      const argNames = field.args.map((a) => a.name);
      for (const want of expected) {
        expect(argNames, `Mutation.${name} should declare "${want}"`).toContain(want);
      }
    },
  );

  it('none of them still declares a legacy <entity>Id reference arg', () => {
    const offenders: string[] = [];
    for (const name of Object.keys(EXPECTED_REF_ARGS)) {
      for (const arg of fields[name]?.args ?? []) {
        const isLegacy = /^(id|.*Id)$/.test(arg.name) && !ALLOWED_ID_ARGS.has(arg.name);
        if (isLegacy) offenders.push(`${name}.${arg.name}`);
      }
    }
    // `createApp.agentId` was exactly this — SDL saying Id while the resolver
    // read agentRef, so the mutation was unusable through the real API.
    expect(offenders).toEqual([]);
  });
});
