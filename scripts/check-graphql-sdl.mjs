#!/usr/bin/env node
/**
 * GraphQL SDL parse gate.
 *
 * Imports `typeDefs` from `src/api/graphql/schema/typeDefs.ts` (the
 * single SDL source) and runs `graphql.parse()` on it. Fails the
 * process with a non-zero exit if the SDL doesn't parse.
 *
 * Catches the class of bug from PR #136: a `"""docstring"""` block
 * accidentally left adjacent to another `"""docstring"""` block on
 * the same definition. `tsc` can't see this because the SDL lives
 * inside a template literal (opaque to TypeScript); the vitest suite
 * doesn't necessarily import `typeDefs` in a path that triggers
 * parse-at-module-load; the runtime parse only fires on first
 * `makeExecutableSchema` / Apollo init, which can be at process
 * boot. Result: bad SDL can survive every existing gate and only
 * surface in production as a boot loop.
 *
 * This script is a 10-line guard. Run from CI on every PR that
 * touches the SDL or anything that could ship a new SDL fragment.
 */
import { parse } from 'graphql';
import { typeDefs } from '../src/api/graphql/schema/typeDefs.js';

try {
  parse(typeDefs);
  console.log('✓ GraphQL SDL parses cleanly.');
} catch (e) {
  console.error('✗ GraphQL SDL failed to parse:');
  console.error(e.message);
  process.exit(1);
}
