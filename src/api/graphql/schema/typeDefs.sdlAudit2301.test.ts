import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { findPartialEnumerations } from '../../../../scripts/check-sdl-enumerations.mjs';

function description(type: string, field: string): string {
  const definition = parse(typeDefs).definitions.find(n => 'name' in n && n.name?.value === type);
  if (!definition || !('fields' in definition)) throw new Error(`Missing ${type}`);
  return definition.fields!.find(n => n.name.value === field)?.description?.value ?? '';
}

describe('#2301 SDL S1 audited claims', () => {
  it('states the authorized own-App key read instead of the retired blanket refusal', () => {
    const text = description('Query', 'agentTasks');
    expect(text).toContain("App's own live key");
    expect(text).not.toContain('a pure App key is refused');
  });
  it('states queued and rootsOnly filter precedence', () => {
    const text = description('Query', 'agentTasks');
    expect(text).toContain('take precedence over status and parentTaskId');
  });
  it('includes the reporting worker in task reassignment authority', () => {
    expect(description('Mutation', 'reassignAgentTask')).toContain('a worker the owner reports to');
  });
  it('includes the bounded reporting-worker stall clear', () => {
    const text = description('Mutation', 'setWorkerAvailability');
    expect(text).toContain('reports to');
    expect(text).toContain('stall rule');
  });
  it('states isolation is unavailable while its implementation switch is off', () => {
    expect(description('Mutation', 'isolateWorker')).toContain('WORKER_ISOLATION_UNAVAILABLE');
  });
  it('the default enumeration registry detects omitted host operation types', () => {
    const fixture = 'type Query { "worktree.create, worker.start" operations: String }';
    expect(findPartialEnumerations(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({ set: 'HOST_OPERATION_TYPES', missing: expect.arrayContaining(['worker.end']) }),
    ]));
  });
  it('the default enumeration registry detects omitted task-warning codes', () => {
    const fixture = 'type Query { "task.create.no-source, task.assign.assignee-busy" warnings: String }';
    expect(findPartialEnumerations(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({ set: 'TASK_WARNING_CODES', missing: expect.arrayContaining(['task.assign.assignee-paused']) }),
    ]));
  });
});
