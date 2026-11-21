/** #632: memory retrieval is a distinct opt-in, free run capability, not web_search. */
import { describe, expect, it } from 'vitest';
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
