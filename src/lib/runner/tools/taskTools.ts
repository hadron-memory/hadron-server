/**
 * hadron_task_create — a headless run creates a root agent task in its OWN App
 * (#1756, cor:agt:050:06; Holger, team chat #7799). The run is recorded as the
 * creator. Roots only. The run's App is the only App it can reach: it is the
 * App of the run the kernel hands in (never an argument), and the stored run row
 * is re-read under the write's locks and must name that same App and still be
 * RUNNING. An `appRef` that names any other App is refused like a missing one.
 */

import { createRootTaskForRun } from '../../../api/graphql/schema/resolvers.agentTask.js';
import type { RunToolDef } from './types.js';

const PARTY = {
  type: 'object',
  description: 'Exactly one of worker (id, URN or name) or user (id or handle).',
  properties: { worker: { type: 'string' }, user: { type: 'string' } },
};

export const hadronTaskCreate: RunToolDef = {
  name: 'hadron_task_create',
  description:
    'Create a root task in this run\'s own App, attributed to this run. Name the owner (a worker of the App or a ' +
    'person who participates in it); if the run acts for a person and you name none, that person owns it. ' +
    'A run creates root tasks only and can reach no other App.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What is asked, in the team\'s own words.' },
      description: { type: 'string' },
      source: { type: 'string', description: 'Opaque origin reference (an issue URL, a node URN).' },
      owner: PARTY,
      assignee: PARTY,
      tags: { type: 'array', items: { type: 'string' } },
      startBy: { type: 'string', description: 'ISO date-time.' },
      closeSessionWhenDone: { type: 'boolean', description: 'Default false: the assignee\'s session ends only when you ask (cor:agt:050:10).' },
    },
    required: ['title'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    // Only the named fields are read: nothing else in `args` reaches the task (no creator, no App, no parent).
    const task = await createRootTaskForRun(ctx.principal, ctx.run, {
      appRef: typeof args.appRef === 'string' ? args.appRef : null,
      parentTaskId: args.parentTaskId,
      // Forwarded only to be refused (#1832): the helper turns any non-null status away, so it is never silently dropped here.
      status: args.status as never,
      title: args.title as string,
      description: args.description as string | undefined,
      source: args.source as string | undefined,
      owner: args.owner as never,
      assignee: args.assignee as never,
      tags: args.tags as string[] | undefined,
      startBy: args.startBy,
      closeSessionWhenDone: args.closeSessionWhenDone as boolean | undefined,
    });
    ctx.log(`created root task ${task.id}`);
    return { id: task.id, status: task.status, queued: !task.assigneeWorkerId && !task.assigneeUserId };
  },
};

export const TASK_TOOLS: readonly RunToolDef[] = [hadronTaskCreate];
