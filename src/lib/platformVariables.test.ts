import { describe, expect, it } from 'vitest';
import {
  agentOnlyVariableValues,
  bindPlatformVariables,
  PLATFORM_VARIABLES,
  type PlatformVariableValues,
} from './platformVariables.js';

const values = (over: Partial<PlatformVariableValues> = {}): PlatformVariableValues => ({
  'worker.name': 'Ada',
  'worker.role': 'coordinator',
  'agent.name': 'Coordinator Agent',
  'worker.reportsTo.name': 'Eden',
  'worker.signature': 'sig',
  'worker.trailer': 'Worker: Ada',
  'worker.url': 'https://portal.example/app/u/hrn:worker:o:a:ada',
  'session.llmModel': 'claude-sonnet-5-5',
  ...over,
});

describe('platform variables (#2042, cor:dmo:150:08)', () => {
  it('the closed set is exactly the eight spec variables', () => {
    expect([...PLATFORM_VARIABLES]).toEqual([
      'worker.name', 'worker.role', 'agent.name', 'worker.reportsTo.name',
      'worker.signature', 'worker.trailer', 'worker.url', 'session.llmModel',
    ]);
  });

  it('fills every variable of the set, and the legacy pair alongside', () => {
    const template = PLATFORM_VARIABLES.map((v) => `${v}={{${v}}}`).join('|') + '|{{name}}/{{role}}';
    expect(bindPlatformVariables(template, values())).toBe(
      'worker.name=Ada|worker.role=coordinator|agent.name=Coordinator Agent|worker.reportsTo.name=Eden|'
      + 'worker.signature=sig|worker.trailer=Worker: Ada|worker.url=https://portal.example/app/u/hrn:worker:o:a:ada|'
      + 'session.llmModel=claude-sonnet-5-5|Ada/coordinator',
    );
  });

  it('inserts values literally: no re-expansion, no replacement patterns', () => {
    const out = bindPlatformVariables('{{worker.name}} {{worker.role}}', values({ 'worker.name': '{{worker.role}}$&$1', 'worker.role': '{{name}}' }));
    expect(out).toBe('{{worker.role}}$&$1 {{name}}');
  });

  it('leaves tokens outside the set, and inexact spellings, written as-is', () => {
    const template = '{{field}} {{node.worker.name}} {{ worker.name }} {{worker}} {{worker.unknown}} {{session.id}} {{worker.name }}';
    expect(bindPlatformVariables(template, values())).toBe(template);
  });

  it('a null value leaves that variable written; an empty one fills with nothing', () => {
    expect(bindPlatformVariables('[{{worker.url}}][{{worker.trailer}}]', values({ 'worker.url': null, 'worker.trailer': '' })))
      .toBe('[{{worker.url}}][]');
  });

  it('with no worker: the Agent names itself, takes its portal URL, and worker-only attributes are empty', () => {
    const v = agentOnlyVariableValues({ name: 'Mealplan', personaRole: 'cook' }, { url: 'https://portal.example/app/u/agent', llmModel: 'm-1' });
    expect(bindPlatformVariables('{{worker.name}}|{{worker.role}}|{{agent.name}}|{{worker.reportsTo.name}}|{{worker.signature}}|{{worker.trailer}}|{{worker.url}}|{{session.llmModel}}', v))
      .toBe('Mealplan|cook|Mealplan||||https://portal.example/app/u/agent|m-1');
    const bare = agentOnlyVariableValues({ name: 'Mealplan', personaRole: null }, { url: null, llmModel: null });
    expect(bindPlatformVariables('[{{worker.role}}][{{worker.url}}][{{session.llmModel}}]', bare)).toBe('[][][]');
  });
});
