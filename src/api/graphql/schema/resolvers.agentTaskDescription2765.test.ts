import { buildSchema, graphqlSync } from 'graphql';
import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';

const result = graphqlSync({
  schema: buildSchema(typeDefs),
  source: '{ task: __type(name: "AgentTask") { description } page: __type(name: "AgentTaskDependencyPage") { description } }',
});
const descriptions = result.data as {
  task: { description: string | null };
  page: { description: string | null };
};

describe('#2765 AgentTask introspection description', () => {
  it('attaches the work description to AgentTask', () => {
    expect(result.errors).toBeUndefined();
    expect(descriptions.task.description ?? '').toMatch(/^One piece of work a team App has assigned/);
  });

  it('does not attach the work description to AgentTaskDependencyPage', () => {
    expect(result.errors).toBeUndefined();
    expect(descriptions.page.description ?? '').not.toContain('One piece of work a team App has assigned');
  });
});
