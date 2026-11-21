/**
 * #4085: cor:agt:120:01 and :03 are retired from the server. The server-side intake reads and claims are gone, and
 * cor:agt:120:02 (the unique external id and TASK_EXTERNAL_ID_TAKEN) stays.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSchema } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers } from './resolvers.js';
import { TASK_TOOLS } from '../../../lib/runner/tools/taskTools.js';

const schema = buildSchema(typeDefs);

describe('#4085 retired intake surfaces', () => {
  it('the query, the mutation and their types are not in the SDL', () => {
    expect(schema.getQueryType()!.getFields().untrackedTaskItems).toBeUndefined();
    expect(schema.getMutationType()!.getFields().claimUntrackedTaskItems).toBeUndefined();
    for (const name of ['UntrackedTaskItem', 'UntrackedTaskItemPage', 'ClaimUntrackedTaskItemsResult', 'ReadyFilter']) {
      expect(schema.getType(name), name).toBeUndefined();
    }
  });

  it('no resolver is wired for them', () => {
    expect((resolvers.Query as Record<string, unknown>).untrackedTaskItems).toBeUndefined();
    expect((resolvers.Mutation as Record<string, unknown>).claimUntrackedTaskItems).toBeUndefined();
  });

  it('a run no longer has the untracked list and claim tools; hadron_task_create stays', () => {
    expect(TASK_TOOLS.map((t) => t.name)).toEqual(['hadron_task_create']);
  });

  it('the retired source files are gone', () => {
    for (const f of ['src/lib/taskIntegrations/untracked.ts', 'src/api/graphql/schema/resolvers.untrackedTaskItems.ts']) {
      expect(existsSync(new URL(`../../../../${f}`, import.meta.url)), f).toBe(false);
    }
  });
});

describe('#4085 cor:agt:120:02 is kept', () => {
  it('the partial unique index on the external id is still declared', () => {
    const sql = readFileSync(new URL('../../../../prisma/agent-task-external-id-invariants.sql', import.meta.url), 'utf8');
    expect(sql).toContain('agent_tasks_app_external_id_uniq');
  });

  it('TASK_EXTERNAL_ID_TAKEN is still documented in the SDL', () => {
    expect(typeDefs).toContain('TASK_EXTERNAL_ID_TAKEN');
  });
});
