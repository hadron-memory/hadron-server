/**
 * GraphQL field-removal regression for 008-agent-installation T034.
 *
 * The pre-008 surface had:
 *   - App.agentSubscriptions: [AppAgentSub!]!  (synthetic AppAgent join)
 *   - type AppAgentSub
 *   - enum AppAgentRole
 *
 * 008 removes them. The legacy App.agents (plural) is kept as @deprecated
 * for portal soft-landing — verify it still parses but is flagged.
 *
 * Approach: build the schema from the SDL via `buildSchema`, then `parse +
 * validate` representative queries. Validation errors at this level are
 * exactly the "Cannot query field" / "Unknown type" responses real clients
 * see at the HTTP layer.
 */

import { describe, it, expect } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';

const schema = buildSchema(typeDefs);

function validationErrorMessages(query: string): string[] {
  const errors = validate(schema, parse(query));
  return errors.map((e) => e.message);
}

describe('008-agent-installation — GraphQL field-removal regression (T041)', () => {
  it('App.appAgents does not exist on the App type', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id appAgents { agentId } } }
    `);
    expect(errors.some((m) => m.includes('Cannot query field "appAgents"'))).toBe(true);
  });

  it('App.agentSubscriptions does not exist on the App type', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id agentSubscriptions { agentId } } }
    `);
    expect(errors.some((m) => m.includes('Cannot query field "agentSubscriptions"'))).toBe(true);
  });

  it('AppAgentSub type does not exist', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id ... on AppAgentSub { agentId } } }
    `);
    expect(
      errors.some(
        (m) =>
          m.includes('Unknown type "AppAgentSub"') ||
          m.includes('Cannot query field') ||
          m.includes('does not exist'),
      ),
    ).toBe(true);
  });

  it('AppAgentRole enum does not exist (the legacy mutation arg type is gone)', () => {
    const errors = validationErrorMessages(`
      mutation { addAgentToApp(appId: "a", agentId: "g", role: DEVELOP) { id } }
    `);
    // The mutation no longer accepts a `role` arg; either the unknown arg
    // or the unknown enum value would fire.
    expect(
      errors.some(
        (m) =>
          m.includes('role') || m.includes('AppAgentRole') || m.includes('Unknown'),
      ),
    ).toBe(true);
  });

  it('App.agent (singular) is the canonical replacement', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id agent { id name } } }
    `);
    expect(errors).toEqual([]);
  });

  it('App.agents (plural) still parses but is @deprecated', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id agents { id } } }
    `);
    expect(errors).toEqual([]);
    // @deprecated is not a validation error, but the schema introspection
    // exposes the deprecation reason. Spot-check that.
    const appType = schema.getType('App');
    const fields = (appType as unknown as {
      getFields: () => Record<string, { deprecationReason?: string | null }>;
    }).getFields();
    const agentsField = fields.agents;
    expect(agentsField).toBeDefined();
    expect(agentsField.deprecationReason).toMatch(/App\.agent/);
  });

  it('App.members and App.memberCount are part of the new surface', () => {
    const errors = validationErrorMessages(`
      query { app(id: "x") { id members { userId role } memberCount } }
    `);
    expect(errors).toEqual([]);
  });

  it('Agent.memoryProvisioning and Agent.installationPolicy are part of the new surface', () => {
    // No top-level agent(id) query exists; reach Agent through Organization.
    const errors = validationErrorMessages(`
      query {
        organization(id: "o") {
          id
          agents {
            id
            memoryProvisioning { appMemory }
            installationPolicy { maxMembers memberRoles }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it('Memory.app and Memory.appId are part of the new surface', () => {
    const errors = validationErrorMessages(`
      query { memory(id: "m") { id appId app { id urn } } }
    `);
    expect(errors).toEqual([]);
  });
});
