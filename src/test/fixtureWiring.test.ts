import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertFixtureWiring } from './fixtureWiring.js';
const source = readFileSync(new URL('../mcp/server.rateLimit1793.test.ts', import.meta.url), 'utf8');
it('checks the real parity wiring without executing the module', () => assertFixtureWiring(source));
it('accepts harmless formatting and comments, not comment/string lookalikes', () => {
  assertFixtureWiring(source.replaceAll('fixtureIt(', 'fixtureIt /* comment */ (').replace('lifetime.run(body)', 'lifetime\n .run( /* body */ body )').replace('await lifetime.drain(closeResources);', '/* before */ await lifetime\n .drain( closeResources );'));
});
it.each([
  ['A1', (s: string) => s.replace("fixtureIt('#1793", "it('#1793"), 'eight fixture registrations required'],
  ['A2', (s: string) => s.replace('lifetime.run(body)', 'body() /* lifetime.run(body) */'), 'wrapper must enter lifetime.run(body)'],
  ['A3', (s: string) => s.replace('await lifetime.drain(closeResources);', '/* await lifetime.drain(closeResources); */'), 'await drain before any setup'],
  ['A4', (s: string) => s.replace('await lifetime.drain(closeResources);', 'client=undefined; await lifetime.drain(closeResources);'), 'await drain before any setup'],
  ['A5', (s: string) => s.replace('afterEach(()=>lifetime.drain(closeResources));', 'afterEach(()=>{ "afterEach(()=>lifetime.drain(closeResources))"; });'), 'afterEach must join drain'],
  ['A6', (s: string) => s.replace('closeFixtureResources(resources)', 'Promise.resolve() /* closeFixtureResources(resources) */'), 'closeResources must delegate to closeFixtureResources(resources)'],
  ['A6b', (s: string) => s.replace('closeFixtureResources(resources)', 'closeFixtureResources(other)'), 'closeResources must delegate to closeFixtureResources(resources)'],
  ['A6c', (s: string) => s.replace('closeFixtureResources(resources)', 'closeFixtureResource(resources)'), 'closeResources must delegate to closeFixtureResources(resources)'],
] as const)('rejects %s with an intended wiring error', (_name, mutate, message) => {
  const changed = mutate(source);
  expect(changed).not.toBe(source);
  expect(() => assertFixtureWiring(changed)).toThrow(message);
});
