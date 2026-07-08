/**
 * Portal #478 — AppRun.data (the run envelope) exposed in the GraphQL
 * schema. PR #532 stored the envelope on the AppRun row (walker
 * checkpoints write it) but the AppRun type never declared it, so the
 * portal's run-detail view couldn't select the one field that shows
 * WHAT a flow extracted. Same bug class as the spec-033 embedding-state
 * fields (see resolvers.embeddingState.test.ts).
 *
 * The appRun/appRuns resolvers return the Prisma row unchanged, so
 * declaring the field is sufficient — the default resolver reads
 * row.data.
 */

import { describe, it, expect } from 'vitest';
import { typeDefs } from './typeDefs.js';

describe('Portal #478 — AppRun envelope exposed in GraphQL schema', () => {
  it('declares data: JSON on the AppRun type', () => {
    const appRunBlock = typeDefs.match(/type AppRun \{[^}]*\}/)?.[0];
    expect(appRunBlock).toBeDefined();
    expect(appRunBlock).toMatch(/\n\s*data:\s*JSON\b/);
  });
});

describe('#548 — fan-out state exposed in GraphQL schema', () => {
  it('declares spawn: JSON on the AppRun type', () => {
    // The envelope test's `[^}]*` block-match truncates at the first `}`
    // inside a docstring; the spawn field sits AFTER one. Match the type
    // block up to its closing brace at column 2 instead.
    const appRunBlock = typeDefs.match(/type AppRun \{[\s\S]*?\n {2}\}/)?.[0];
    expect(appRunBlock).toBeDefined();
    expect(appRunBlock).toMatch(/\n\s*spawn:\s*JSON\b/);
  });

  it('appRuns accepts a parentRunId filter', () => {
    expect(typeDefs).toMatch(/appRuns\([^)]*parentRunId:\s*ID[^)]*\)/);
  });
});
