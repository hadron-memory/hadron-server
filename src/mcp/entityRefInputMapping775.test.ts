/**
 * #5080: the MCP ticker, inbox-ack and task-create tools keep their input names (and so their success output) while the
 * GraphQL inputs are refs. The tools are switched off (#3082 R4, no test path back), so the mapping is pinned directly,
 * as in agentTaskToolsRefArgs4148, together with the one refusal wording per family that now names the GraphQL field.
 */
import { describe, expect, it } from 'vitest';
import { mcpTaskCreateInput } from './agentTaskTools.js';
import { mcpAckThrough, mcpTickerInput } from './tickerTools.js';

describe('#5080 MCP input mapping', () => {
  it('hadron_ticker_create and hadron_ticker_update: channelIds becomes channelRefs, an empty list stays, absent stays absent', () => {
    expect(mcpTickerInput({ name: 'n', channelIds: ['a', 'b'] })).toEqual({ name: 'n', channelRefs: ['a', 'b'] });
    expect(mcpTickerInput({ channelIds: [] })).toEqual({ channelRefs: [] });
    expect(mcpTickerInput({ name: 'n' })).toEqual({ name: 'n' });
    expect(mcpTickerInput({ channelIds: ['a'] })).not.toHaveProperty('channelIds');
  });
  it('hadron_team_chat_inbox_ack: through[].channelId becomes channelRef, order and seq unchanged', () => {
    expect(mcpAckThrough([{ channelId: 'a', seq: 2 }, { channelId: 'b', seq: 3 }])).toStrictEqual([{ channelRef: 'a', seq: 2 }, { channelRef: 'b', seq: 3 }]);
  });
  it('hadron_task_create: parentTaskId becomes parentTaskRef, every other argument passes through, absent stays absent', () => {
    expect(mcpTaskCreateInput({ title: 't', parentTaskId: 'AT3' })).toEqual({ title: 't', parentTaskRef: 'AT3' });
    expect(mcpTaskCreateInput({ title: 't', parentTaskId: undefined })).toStrictEqual({ title: 't' });
    expect(mcpTaskCreateInput({ title: 't', parentTaskId: 'AT3' })).not.toHaveProperty('parentTaskId');
  });
});
