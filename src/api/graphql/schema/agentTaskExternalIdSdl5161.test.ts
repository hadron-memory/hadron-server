/**
 * #5161 (hrn:node:hadronmemory.com:specs:cor:agt:120:02, the 2026-11-14 amendment built by #4321): the SDL description of
 * `CreateAgentTaskInput.externalId` states the active-only rule the server enforces. At most one ACTIVE task (backlog,
 * pending or started) per App holds a given value; a finished or cancelled task keeps its value but no longer blocks a
 * new claim. The pre-#4217 "whatever the first task's state" wording told clients the opposite.
 */
import { describe, expect, it } from 'vitest';
import { parse, type InputObjectTypeDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';

const externalIdDescription = (): string => {
  const input = parse(typeDefs).definitions.find(
    (d): d is InputObjectTypeDefinitionNode => d.kind === 'InputObjectTypeDefinition' && d.name.value === 'CreateAgentTaskInput',
  );
  const field = input?.fields?.find((f) => f.name.value === 'externalId');
  return (field?.description?.value ?? '').replace(/\s+/g, ' ');
};

describe('#5161: CreateAgentTaskInput.externalId describes the active-only rule', () => {
  it('states the active-only rule, in the CLI\'s words', () => {
    expect(externalIdDescription()).toContain(
      'At most one ACTIVE task (backlog, pending or started) per App holds a given value; a finished or cancelled task '
        + 'keeps its value but no longer blocks a new claim.',
    );
  });

  it('no longer says any state blocks a second task', () => {
    expect(externalIdDescription()).not.toMatch(/whatever the first task's state/);
  });

  it('still names the refusal and how to find the holder', () => {
    expect(externalIdDescription()).toContain('TASK_EXTERNAL_ID_TAKEN');
    expect(externalIdDescription()).toContain('agentTasks(externalId:)');
  });
});
