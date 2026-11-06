import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertFixtureWiring } from './fixtureWiring.js';
const source = readFileSync(new URL('../mcp/server.rateLimit1793.test.ts', import.meta.url), 'utf8');
it('checks the real parity wiring without executing the module', () => assertFixtureWiring(source));
it('accepts harmless formatting and comments, not comment/string lookalikes', () => {
  assertFixtureWiring(source.replaceAll('fixtureIt(', 'fixtureIt /* comment */ (').replace('lifetime.run(body)', 'lifetime\n .run( /* body */ body )').replace('await lifetime.drain(closeResources);', '/* before */ await lifetime\n .drain( closeResources );'));
});
it.each([
  ['A1', (s: string) => s.replace("fixtureIt('#1793", "it('#1793")],
  ['A2', (s: string) => s.replace('lifetime.run(body)', 'body() /* lifetime.run(body) */')],
  ['A3', (s: string) => s.replace('await lifetime.drain(closeResources);', '/* await lifetime.drain(closeResources); */')],
  ['A4', (s: string) => s.replace('await lifetime.drain(closeResources);', 'client=undefined; await lifetime.drain(closeResources);')],
  ['A5', (s: string) => s.replace('afterEach(()=>lifetime.drain(closeResources));', 'afterEach(()=>{ "afterEach(()=>lifetime.drain(closeResources))"; });')],
] as const)('rejects %s with an intended wiring error', (_name, mutate) => expect(() => assertFixtureWiring(mutate(source))).toThrow());
