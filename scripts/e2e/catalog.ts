import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const orgs = ['e2e-alpha', 'e2e-beta'];
export { workerNames } from '../../src/test/e2eWorkerNames.js';
// Golden access expectations: system is excluded from the ordinary memory list;
// group requires MemoryMember, and strict-owner memories belong to the admin.
// App team records require participation; worker records require management
// or holding that worker. These are record-list expectations, not node grants.
const sharedMemories = (org: string) => ['knowledge', 'specs'].map(slug => `${org}:${slug}`);
const managedMemories = (org: string) => [
  ...sharedMemories(org), ...['group', 'app', 'coordinator-working', 'qa-engineer-working'].map(slug => `${org}:${slug}`),
];
export const users: Record<string, { memberships: string[]; memories: string[] }> = {
  'alpha-owner': { memberships: ['e2e-alpha:OWNER'], memories: managedMemories('e2e-alpha').filter(m => !m.endsWith(':group')) },
  'alpha-admin': { memberships: ['e2e-alpha:ADMIN'], memories: [...managedMemories('e2e-alpha'), 'e2e-alpha:personal', 'e2e-alpha:private'] },
  'alpha-member': { memberships: ['e2e-alpha:CONTRIBUTOR'], memories: [...sharedMemories('e2e-alpha'), 'e2e-alpha:app'] },
  'beta-owner': { memberships: ['e2e-beta:OWNER'], memories: managedMemories('e2e-beta').filter(m => !m.endsWith(':group')) },
  'beta-admin': { memberships: ['e2e-beta:ADMIN'], memories: [...managedMemories('e2e-beta'), 'e2e-beta:personal', 'e2e-beta:private'] },
  'beta-member': { memberships: ['e2e-beta:CONTRIBUTOR'], memories: [...sharedMemories('e2e-beta'), 'e2e-beta:app'] },
  shared: { memberships: ['e2e-alpha:READER', 'e2e-beta:READER'], memories: orgs.flatMap(sharedMemories) },
  outsider: { memberships: [], memories: ['outsider:private'] },
  visitor: { memberships: [], memories: ['visitor:private'] },
};

export function checkDocumentInventory() {
  const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  const match = readme.match(/<!-- fixture-users -->\n([\s\S]*?)\n<!-- \/fixture-users -->/);
  assert(match, 'README fixture table markers missing');
  const actual = match[1].split('\n').map(row => row.split('|').map(cell => cell.trim()));
  const expected = [
    ['', 'Handle', ...orgs, ''], ['', '---', '---', '---', ''],
    ...Object.entries(users).map(([handle, fixture]) => ['', handle,
      ...orgs.map(org => fixture.memberships.find(m => m.startsWith(`${org}:`))?.split(':')[1] ?? '—'), '']),
  ];
  assert.deepEqual(actual, expected, 'README inventory differs from the shared fixture catalog');
}
