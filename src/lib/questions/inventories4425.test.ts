/** #4425: the rename must keep every path-keyed caller inventory addressable. */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const current = 'src/api/graphql/schema/resolvers.questions.ts';
const former = 'src/api/graphql/schema/resolvers.decisions.ts';
it('keeps the include-history JSON census keyed to the real question resolver', () => {
  const census = JSON.parse(read('src/lib/includes/includeHistoryCallerInventory2063.json'));
  expect(existsSync(fileURLToPath(new URL(current, root)))).toBe(true);
  expect(census[`${current} :: ensureCurrentNodeRevisionInTransaction`]).toBe(2);
  expect(Object.keys(census).some((key) => key.startsWith(`${former} ::`))).toBe(false);
});
it('keeps the include-history engineering listing on the question resolver path', () => {
  const guide = read('docs/engineering/include-history-callers.md');
  expect(guide).toContain(`${current} :: ensureCurrentNodeRevisionInTransaction`);
  expect(guide).not.toContain(former);
});
it('keeps the operation-key runbook inventory on the question resolver path', () => {
  const inventory = JSON.parse(read('docs/runbooks/operation-key-caller-inventory.json'));
  const server = inventory.repositories.find((r: { repo: string }) => r.repo === 'hadron-server');
  expect(server.matchingPaths[current]).toBe(1);
  expect(server.matchingPaths[former]).toBeUndefined();
});
