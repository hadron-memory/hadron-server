#!/usr/bin/env node
/**
 * GraphQL SDL export.
 *
 * Imports `typeDefs` from `src/api/graphql/schema/typeDefs.ts` (the
 * single SDL source), builds the schema, and prints the canonical
 * SDL to stdout. `lexicographicSortSchema` keeps the output stable
 * across cosmetic reorderings in typeDefs so downstream snapshots
 * diff cleanly.
 *
 * Consumers: hadron-cli commits the output as `schema/schema.graphql`
 * and runs genqlient codegen against it (`make schema` there invokes
 * this script). Run via `pnpm schema:export` — the `.ts` import
 * through a `.js` specifier requires tsx, same as check-graphql-sdl.
 */
import { buildSchema, printSchema, lexicographicSortSchema } from 'graphql';
import { typeDefs } from '../src/api/graphql/schema/typeDefs.js';

try {
  const schema = lexicographicSortSchema(buildSchema(typeDefs));
  process.stdout.write(printSchema(schema) + '\n');
} catch (e) {
  console.error('✗ GraphQL SDL failed to build:');
  console.error(e.message);
  process.exit(1);
}
