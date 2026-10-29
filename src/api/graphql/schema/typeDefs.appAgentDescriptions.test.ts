/**
 * #1246 — the App↔Agent descriptions once published three generations of the
 * model at once: a direct App.agentId FK, a one-Agent deployment, and the live
 * AppAgent N:M join. Pin the structural facts that must move together when the
 * model changes again; wording remains free.
 */

import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';

const flat = (value: string) => value.replace(/\s+/g, ' ').toLowerCase();

function before(symbol: string, start: string, max = 1800): string {
  const at = typeDefs.indexOf(symbol);
  expect(at, `${symbol} must exist`).toBeGreaterThan(0);
  const from = typeDefs.lastIndexOf(start, at);
  expect(from, `${symbol} must have its audited description`).toBeGreaterThanOrEqual(0);
  return flat(typeDefs.slice(Math.max(from, at - max), at));
}

describe('#1246 — App and Agent descriptions publish the live install model', () => {
  it('App is user-or-org owned and installs many Agents through AppAgent', () => {
    const block = before('type App {', 'A runtime caller identity');

    expect(block).toMatch(/organization or user/);
    expect(block).toContain('appagent n:m join');
    expect(block).toMatch(/one app may install many agents/);
    expect(block).not.toMatch(/app\.agent_id|direct fk/);
  });

  it('Agent is a reusable definition, not a one-Agent App deployment', () => {
    const block = before('type Agent {', 'The reusable definition');

    expect(block).toContain('appagent n:m join');
    expect(block).toMatch(/app may install many agents/);
    expect(block).toMatch(/agent may be installed in many apps/);
    expect(block).toMatch(/app.*caller identity and deployment/);
    expect(block).not.toMatch(/an app is the deployment of an agent/);
  });

  it('installedAgentUrn states that it selects the first install', () => {
    const block = before('installedAgentUrn: String', 'SOFT-DEPRECATED convenience read');

    expect(block).toMatch(/first installed agent/);
    expect(block).toMatch(/use appagents for the full install roster/);
    expect(block).toMatch(/null when the app has no installed agent/);
  });

  it('createApp distinguishes org-owned and personal install behavior', () => {
    const block = before('createApp(', 'Create an App and install its initial Agent', 2600);
    const createAt = typeDefs.indexOf('createApp(');
    const agentRefAt = typeDefs.indexOf('agentRef: ID!', createAt);
    expect(agentRefAt).toBeGreaterThan(createAt);
    const agentRef = flat(typeDefs.slice(createAt, agentRefAt));

    expect(block).toMatch(/with orgref.*organization.*without orgref.*user/);
    expect(block).toMatch(/only when that role is present/);
    expect(block).toMatch(/personal apps reject dependency cascades/);
    expect(agentRef).toMatch(/initial agent installed into this new app/);
  });

  it('#2640 — the Agent-naming App fields say they are gated and may be partial', () => {
    const primary = before('    agentId: ID\n    agent: Agent', 'SOFT-DEPRECATED convenience read: the FIRST installed Agent.');
    expect(primary).toMatch(/primary install/);
    expect(primary).toMatch(/null when the caller may not read it/);
    expect(primary).toMatch(/null is not proof that nothing is installed/);
    expect(primary).toMatch(/entry whose `agent` is null/);
    const list = before('    agents: [Agent!]!', '023-app-shape: convenience list of the installed Agents');
    expect(list).not.toMatch(/equivalent to App\.appAgents\.map/i);
    expect(list).not.toMatch(/FULL multi-Agent set/i);
    expect(list).toMatch(/appagents/);
    expect(list).toMatch(/may read/);
    expect(list).toMatch(/may be partial/);
    expect(list).toMatch(/not the install count/);
    const urn = before('    installedAgentUrn: String', 'SOFT-DEPRECATED convenience read: the FIRST installed Agent\'s canonical', 3000);
    expect(urn).toMatch(/may not read that agent/);
  });
});
