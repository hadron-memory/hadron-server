/** #670 — a script node's declared tool is pinned and shown to the approver like a model-called tool. */
import { describe, it, expect } from 'vitest';
import { flowToolNames } from './pins.js';
import { summarizeAutomation } from './approvalSummary.js';

describe('script node tools in the automation pin and summary (#670)', () => {
  it('flowToolNames includes the script call tool beside data.tools', () => {
    expect(flowToolNames({ tools: ['hadron_log'] })).toEqual(['hadron_log']);
    expect(flowToolNames({ script: { call: { tool: 'mcp__crm__lookup', args: {} } } })).toEqual(['mcp__crm__lookup']);
    expect(flowToolNames(null)).toEqual([]);
    expect(flowToolNames({ script: { call: {} } })).toEqual([]);
  });

  it('the approval summary lists a script node tool', () => {
    const pin = {
      entryId: 'n1', flows: ['n1'], userId: null, absentPartials: [],
      nodes: { n1: { urn: 'hrn:node:o:m:flow:s', state: { name: 'Alert', data: { script: { call: { tool: 'hadron_send_email', args: {} } } } } } },
    } as never;
    const summary = summarizeAutomation(pin, { kind: 'MANUAL' } as never);
    expect(summary.flows[0]!.tools).toEqual(['hadron_send_email']);
    expect(summary.tools).toEqual(['hadron_send_email']);
  });
});
