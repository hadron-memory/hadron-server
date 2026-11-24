/**
 * #4148 (S7), Billie's BLIND P2-1: the MCP task tools keep their parameter names (golden #2260) while the GraphQL
 * arguments are refs. The mapping is pinned here directly: the tools are switched off (#3082 R4, no test path back), and
 * a dropped mapping would silently widen hadron_task_list / hadron_team_events to the whole App when switched back on.
 */
import { describe, expect, it } from 'vitest';
import { mcpTaskListArgs, mcpTaskRefArgs } from './agentTaskTools.js';

describe('#4148 MCP task-tool argument mapping', () => {
  it('hadron_task_list: parentTaskId becomes parentTaskRef, every other filter passes through, absent stays absent', () => {
    expect(mcpTaskListArgs({ appRef: 'a', parentTaskId: 'AT3', status: ['PENDING'] })).toEqual({ appRef: 'a', parentTaskRef: 'AT3', status: ['PENDING'] });
    expect(mcpTaskListArgs({ appRef: 'a', status: ['PENDING'] })).toEqual({ appRef: 'a', status: ['PENDING'] });
    expect(mcpTaskListArgs({ appRef: 'a', parentTaskId: 'AT3' })).not.toHaveProperty('parentTaskId');
  });
  it('hadron_team_events, hadron_task_assign and hadron_task_reassign: taskId becomes taskRef, every other argument passes through, absent stays absent', () => {
    expect(mcpTaskRefArgs({ appRef: 'a', taskId: 'AT3.1', alarmsOnly: true })).toEqual({ appRef: 'a', taskRef: 'AT3.1', alarmsOnly: true });
    expect(mcpTaskRefArgs({ appRef: 'a', limit: 5 })).toEqual({ appRef: 'a', limit: 5 });
    expect(mcpTaskRefArgs({ appRef: 'a', taskId: 'AT3.1' })).not.toHaveProperty('taskId');
    expect(mcpTaskRefArgs({ taskId: 'AT3.1', assignee: { worker: 'w' }, closeSessionWhenDone: true })).toEqual({ taskRef: 'AT3.1', assignee: { worker: 'w' }, closeSessionWhenDone: true });
  });
});
