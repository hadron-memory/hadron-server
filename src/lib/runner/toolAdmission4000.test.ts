/** S5: a secret request's budget is charged with its ticket, after the ordinary policy gate. */
import { describe, expect, it, vi } from 'vitest';
import { admitAndExecuteTool } from './toolAdmission.js';
import type { RunToolContext, RunToolDef } from './tools/types.js';
const def: RunToolDef = { name: 'web_request', description: 'test', inputSchema: {}, cost: 1, execute: async () => 'ok' };
const ctx = {} as RunToolContext;
describe('secret use admission (#4000)', () => {
  it('checks the same policy action without spending outside the secret transaction', async () => {
    const gate = vi.fn(async () => true);
    await admitAndExecuteTool(def, { secretClientId: 'synthetic' }, { toolCtx: ctx, onToolCall: gate });
    expect(gate).toHaveBeenCalledExactlyOnceWith('tool.web_request', 0);
    gate.mockClear();
    await admitAndExecuteTool(def, { url: 'https://example.test/' }, { toolCtx: ctx, onToolCall: gate });
    expect(gate).toHaveBeenCalledExactlyOnceWith('tool.web_request', 1);
    gate.mockClear();
    await admitAndExecuteTool(def, { secretClientId: null }, { toolCtx: ctx, onToolCall: gate });
    expect(gate).toHaveBeenCalledExactlyOnceWith('tool.web_request', 0);
  });
});
