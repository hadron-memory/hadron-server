/**
 * #2325 — descriptions of the isolateWorker refusal ordering and of the task owner directives' reporting-worker
 * audience. Each fact is pinned against the code that decides it (resolvers.ticker.ts writeWorkerIsolation,
 * resolvers.agentTask.ts actorCoordinatesOwner, resolvers.hostOperation.ts), so a change there fails here
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

describe('#2325 isolateWorker names the refusal ordering the resolver implements', () => {
  const text = description('isolateWorker');
  it('lists the codes in the order the resolver checks them', () => {
    const order = ['WORKER_NOT_FOUND', 'WORKER_ISOLATION_FORBIDDEN', 'WORKER_ISOLATION_UNAVAILABLE', 'FORBIDDEN (read-only)']
      .map(token => text.replace('refused FORBIDDEN (read-only)', 'FORBIDDEN (read-only)').indexOf(token));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/pure App key/);
    expect(text).toMatch(/before the manager\/holder check/);
  });
  it('matches the code: read, actor, availability, writability, then manager/holder', () => {
    const body = src('resolvers.ticker.ts');
    const fn = body.slice(body.indexOf('async function writeWorkerIsolation'));
    const at = (needle: string) => fn.indexOf(needle);
    const steps = ['workerForRead(', "actor.kind !== 'user'", '!s7Available()', 'writeInApp(', 'actorManagesApp('].map(at);
    expect(steps.every(i => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(src('resolvers.agentTask.ts')).toMatch(/Impersonation sessions are read-only/);
  });
});

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
