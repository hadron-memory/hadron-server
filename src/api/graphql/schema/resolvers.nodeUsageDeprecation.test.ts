/**
 * #802 — nodeUsage is deprecated in favour of usageEvents(nodeId:).
 *
 * A deprecation is a promise to clients: "this other field does the same thing".
 * Two ways that promise rots silently, both guarded here:
 *
 *   1. The migration TARGET changes or goes away. A `@deprecated` reason is a
 *      free-text string — nothing links it to `usageEvents`, so deprecating or
 *      renaming the target would leave `nodeUsage` pointing at nothing and no
 *      existing test would notice.
 *   2. The deprecated field gets DELETED prematurely. Deprecated ≠ removed:
 *      the whole point of the window is that unmigrated callers keep working.
 *
 * Schema-level only — no DB. The behavioural half of the promise (that the two
 * fields actually return the same rows for the same caller) lives in
 * resolvers.nodeUsage.access.test.ts, where the multi-tenant fixture already is.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';

const queryFields = () => {
  const schema = buildSchema(typeDefs);
  return (schema.getType('Query') as GraphQLObjectType).getFields();
};

describe('nodeUsage deprecation (#802)', () => {
  it('is marked @deprecated and names usageEvents(loc:) as the replacement', () => {
    const field = queryFields().nodeUsage;
    expect(field).toBeDefined();
    expect(field.deprecationReason).toBeTruthy();
    // The reason must actually name the target — "deprecated, use something
    // else" with no destination is worse than no deprecation at all. And the
    // target must be the loc ARGUMENT, not nodeId: nodeId shape-classifies its
    // input, so a hierarchical loc (≥3 colon segments, e.g. 'cor:acl:010:01')
    // qualifies as node-URN shape and routes to ref resolution instead of the
    // loc filter (PR-986 review, Codex P2).
    expect(field.deprecationReason).toContain('usageEvents(loc:');
  });

  it('still exists and is still wired to a resolver (deprecated ≠ removed)', () => {
    // Unmigrated callers must keep working for the whole deprecation window.
    // Removing the field is a breaking change that needs its own decision, not
    // a drive-by cleanup — this test is the tripwire for that.
    expect(queryFields().nodeUsage).toBeDefined();
    expect(typeof resolvers.Query.nodeUsage).toBe('function');
  });

  it('the migration target usageEvents is NOT itself deprecated', () => {
    expect(queryFields().usageEvents.deprecationReason).toBeFalsy();
  });

  it('usageEvents accepts the arguments the deprecation notice promises', () => {
    // The notice tells callers to rewrite nodeUsage(loc:, limit:) as
    // usageEvents(loc:, limit:). If those args are ever renamed, the advice
    // becomes wrong the moment a client follows it.
    const args = new Set(queryFields().usageEvents.args.map((a) => a.name));
    expect(args).toContain('loc');
    expect(args).toContain('limit');
    // The superset the notice advertises as the reason to migrate.
    expect(args).toContain('nodeId');
    expect(args).toContain('type');
    expect(args).toContain('memoryId');
    expect(args).toContain('offset');
  });

  it('nodeUsage still takes exactly (loc, limit) — the deprecated shape is frozen', () => {
    // A deprecated field should not grow arguments; new capability belongs on
    // the target. Freezing the shape here makes that explicit rather than
    // relying on reviewer memory.
    const args = queryFields().nodeUsage.args.map((a) => a.name).sort();
    expect(args).toEqual(['limit', 'loc']);
  });
});
