/**
 * #2325 — descriptions of the task owner directives' reporting-worker
 * audience. Each fact is pinned against the code that decides it (resolvers.agentTask.ts actorCoordinatesOwner, resolvers.hostOperation.ts), so a change there fails here
 * rather than leaving the description wrong. Wording stays free.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';

const flat = (value: string) => value.replace(/\s+/g, ' ');
const src = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

function description(field: string): string {
  const at = typeDefs.indexOf(`    ${field}(`);
  expect(at, `${field} must exist`).toBeGreaterThan(0);
  const close = typeDefs.lastIndexOf('"""', at);
  const open = typeDefs.lastIndexOf('"""', close - 1);
  expect(open).toBeGreaterThanOrEqual(0);
  return flat(typeDefs.slice(open, close));
}

describe('#2325 owner directives name the reporting-worker audience as the chain', () => {
  for (const field of ['assignAgentTask', 'reassignAgentTask', 'cancelAgentTask', 'parkAgentTask', 'makeAgentTaskReady']) {
    it(`${field} says directly or up the reportsTo chain`, () => {
      expect(description(field)).toMatch(/a worker the owner reports to, directly or up the reportsTo chain/);
    });
  }
  it('the chain walk is real, and worktree authority stays direct-only', () => {
    expect(src('resolvers.agentTask.ts')).toMatch(/actorCoordinatesOwner[\s\S]*for \(let hops/);
    expect(description('issueHostOperation')).toMatch(/the worker it reports to directly \(not further up the chain\)/);
    expect(src('resolvers.hostOperation.ts')).toMatch(/target\.reportsToWorkerId === actor\.workerId/);
  });
  it('availability keeps its direct-report exception', () => {
    expect(description('setWorkerAvailability')).toMatch(/A worker another reports to directly may also clear only a stall-rule/);
  });
});


describe('#3590 cloneAgent names the public refusal codes', () => {
  it('uses wire codes rather than the internal blocker keys', () => {
    const text = description('cloneAgent');
    expect(text).toContain('CLONE_BASE_UNUSABLE');
    expect(text).toContain('CLONE_IMPORT_UNUSABLE');
    expect(text).not.toMatch(/\b(?:BASE_UNUSABLE|IMPORT_UNUSABLE)\b/);
  });
});


it('task writes retain the impersonation refusal independently of removed isolation doors', () => {
  expect(src('resolvers.agentTask.ts')).toMatch(/Impersonation sessions are read-only/);
});
