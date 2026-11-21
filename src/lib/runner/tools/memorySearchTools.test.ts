/** #632: memory retrieval is a distinct opt-in, free run capability, not web_search. */
import { describe, expect, it, vi } from 'vitest';
import { evaluatePolicyChain, parsePolicyLink, type PolicyAction } from '@hadron-memory/access-control';
import { admitAndExecuteTool, ToolDeniedError } from '../toolAdmission.js';
import { resolveRunTools } from './index.js';

function tool() {
  const found = resolveRunTools(['hadron_find_nodes']).tools.find(t => t.name === 'hadron_find_nodes');
  expect(found, '#632 must register a distinct memory-search run tool').toBeDefined();
  return found!;
}

describe('#632 run memory search registry and model surface', () => {
  it('resolves explicitly at zero action cost, with its own policy handle', () => {
    expect(resolveRunTools(['hadron_find_nodes']).unknown).toEqual([]);
    expect(tool().cost).toBe(0);
    expect(tool().policyAction).toBe('tool.hadron_find_nodes');
    expect(resolveRunTools([]).tools.map(t => t.name)).not.toContain('hadron_find_nodes');
    expect(resolveRunTools(['web_search']).tools.map(t => t.name)).toContain('web_search');
  });
  it('keeps a closed keyword-only parameter surface and bounds requested hits', () => {
    const schema = tool().inputSchema as { additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['query']);
    expect(Object.keys(schema.properties).sort()).toEqual(['limit', 'memoryUrn', 'query']);
    expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, default: 10 });
    expect(schema.properties).not.toHaveProperty('orgId');
    expect(schema.properties).not.toHaveProperty('principal');
    expect(schema.properties).not.toHaveProperty('mode');
  });
});

const stub = () => ({ db: {} as never, run: { id: 'r', appId: 'a', organizationId: 'o', userId: null } as never,
  principal: { db: {} as never, clientId: 'run:r', appId: 'a', organizationId: 'o' }, log: () => {} });
describe('#632 defensive argument/principal validation', () => {
  it.each([{}, { query: '' }, { query: '  ' }, { query: 1 }, { query: 'x', limit: NaN },
    { query: 'x', limit: 1.5 }, { query: 'x', limit: '2' }, { query: 'x', memoryUrn: '' },
    { query: 'x', mode: 'vector' }, { query: 'x', mode: 'hybrid' }, { query: 'x', orgId: 'foreign' },
  ])('refuses malformed or unsupported input before touching the database: %j', async args => {
    await expect(tool().execute(stub(), args)).rejects.toThrow(/hadron_find_nodes: expected/);
  });
  it('refuses a context that is not this run’s principal before touching the database', async () => {
    for (const patch of [{ clientId: 'run:other' }, { clientId: 'app:a' }, { appId: 'other' },
      { organizationId: 'other' }, { userId: 'other' }]) {
      const context = stub(); context.principal = { ...context.principal, ...patch };
      await expect(tool().execute(context, { query: 'x' })).rejects.toThrow(/invalid run principal/);
    }
  });
});

it('cost-zero search is still denied by the real per-call policy gate before execution', async () => {
  const policy = parsePolicyLink({ allow: ['tool.web_search'] });
  const gate = vi.fn(async (action: string, _cost: number) => evaluatePolicyChain(action as PolicyAction, [policy]));
  const record = vi.fn();
  await expect(admitAndExecuteTool(tool(), { query: 'must not search' }, { toolCtx: stub(), onToolCall: gate, record }))
    .rejects.toBeInstanceOf(ToolDeniedError);
  expect(gate).toHaveBeenCalledWith('tool.hadron_find_nodes', 0);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ name: 'hadron_find_nodes', ok: false }));
  expect(evaluatePolicyChain('tool.hadron_find_nodes', [parsePolicyLink({ allow: ['tool.hadron_find_nodes'] })])).toBe(true);
});
