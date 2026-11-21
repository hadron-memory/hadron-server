/**
 * #4085: cor:agt:120:01 and :03 are retired from the server. The server-side intake reads and claims are gone, and
 * cor:agt:120:02 (the unique external id and TASK_EXTERNAL_ID_TAKEN) stays.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const names = TASK_TOOLS.map((t) => t.name);
    expect(names).toContain('hadron_task_create');
    expect(names).not.toContain('hadron_task_untracked_list');
    expect(names).not.toContain('hadron_task_untracked_claim');
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

describe('#4085 the retired names survive nowhere else (string-level residue, which the compiler cannot see)', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const retired = [
    'hadron_task_untracked',
    'untrackedTaskItems',
    'claimUntrackedTaskItems',
    'UntrackedTaskItem',
    'TASK_INTEGRATION_INVALID',
    'TASK_INTEGRATION_NOT_FOUND',
    'TASK_INTEGRATION_REPOSITORY_NOT_CONNECTED',
    'TASK_INTEGRATION_TEAM_UNKNOWN',
  ];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === 'generated' || e === '.git' || e === 'migrations') continue;
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.(ts|tsx|mjs|js|json|sql|md|graphql|sh)$/.test(e)) out.push(f);
    }
    return out;
  };

  it('no source, script or manifest file names a retired tool, field, type or error code', () => {
    const self = fileURLToPath(import.meta.url);
    const hits: string[] = [];
    for (const dir of ['src', 'scripts', 'prisma']) {
      for (const f of walk(join(root, dir))) {
        if (f === self) continue;
        const text = readFileSync(f, 'utf8');
        for (const name of retired) if (text.includes(name)) hits.push(`${f.slice(root.length)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// Coverage that outlives the deleted untrackedTaskClaims3132.test.ts (#4085):
//  - an App key is refused on every task-domain mutation (cor:agt:050:23): resolvers.agentTaskAppKey1755.test.ts,
//    'every task-domain write is refused for a key', which walks every agent-task mutation by name;
//  - a second create with a live externalId is TASK_EXTERNAL_ID_TAKEN (cor:agt:120:02):
//    resolvers.agentTaskExternalId3125.test.ts and resolvers.agentTaskExternalIdActive4217.test.ts.
