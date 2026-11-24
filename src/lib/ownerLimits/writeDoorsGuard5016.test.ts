/**
 * #5016 (Billing A7c): every creation site of a memory, Agent or App under `src` is classified, so a new one cannot land silently:
 * "refuses" (it asks `requireOwnerHeadroom`), "free, because ..." or "counts, not refused, because ...". The check is by file and
 * count, not by line, so an unrelated edit does not move it. Fixtures are excluded by PLACE (`src/test/`, a `*Fixtures*` file). Slice A7b
 * (#5015) adds the node columns to this table.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Verdict = { n: number; kind: 'refuses' | 'free' | 'counts-not-refused'; because: string; asks?: string };
const SITES: Record<string, Verdict> = {
  'src/api/graphql/schema/resolvers.mutation.memory.ts': { n: 1, kind: 'refuses', because: 'createMemory: every class it accepts is free-standing and counts', asks: 'memories' },
  'src/controller/operations/cloneMemory.ts': { n: 1, kind: 'refuses', because: 'cloneMemory: counts when the copy\'s class does; a cloneAgent system memory is free', asks: 'memories' },
  'src/controller/operations/extractParentNode.ts': { n: 1, kind: 'refuses', because: 'extractParentNodeToMemory: the new memory counts for the target organization', asks: 'memories' },
  'src/api/graphql/schema/resolvers.mutation.agent.ts': { n: 2, kind: 'refuses', because: 'createAgent: the Agent asks `agents`; its system memory (class system) is free', asks: 'agents' },
  'src/lib/agentClone/cloneAgent.ts': { n: 1, kind: 'refuses', because: 'cloneAgent: the Agent asks `agents` (A7b adds `nodes` to the same call)', asks: 'agents' },
  'src/api/graphql/schema/resolvers.mutation.app.ts': { n: 2, kind: 'refuses', because: 'createApp: the App and each dependency App ask `apps`', asks: 'apps' },
  'src/api/graphql/schema/resolvers.mutation.appMemory.ts': { n: 2, kind: 'free', because: 'a memory inside an App (app_id set) is not in the `memories` count' },
  'src/api/graphql/schema/installMemory.ts': { n: 1, kind: 'free', because: 'an install memory is not in the `memories` count' },
  'src/api/graphql/schema/chat-scope.ts': { n: 1, kind: 'free', because: 'the shared App-class memory (class app) is not in the `memories` count' },
  'src/api/graphql/schema/resolvers.worker.ts': { n: 1, kind: 'free', because: 'a worker memory is App-class and not in the `memories` count' },
  'src/api/graphql/schema/resolvers.mutation.session.ts': { n: 2, kind: 'free', because: 'startAgentSession memories carry app_id (class app/personal inside an App) and are never refused' },
  'src/api/graphql/schema/resolvers.mutation.chat.ts': { n: 1, kind: 'counts-not-refused', because: 'startChat with no matching App creates a counted knowledge memory for the Agent\'s organization; chat is never refused (gate ruling 2)' },
};
const WRITE = /\.(memory|agent|app)\.(create|createMany|createManyAndReturn|upsert)\(/g;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === 'generated' ? [] : walk(p)) : [p];
});
const isFixture = (p: string) => p.startsWith('src/test/') || /Fixtures/.test(p);
const found = () => {
  const out: Record<string, number> = {};
  for (const p of walk('src')) {
    if (!p.endsWith('.ts') || p.endsWith('.test.ts') || isFixture(p)) continue;
    const n = (readFileSync(p, 'utf8').match(WRITE) ?? []).length;
    if (n) out[p] = n;
  }
  return out;
};

describe('#5016 every memory, Agent and App creation site under src is classified', () => {
  it('the table and the source agree, by file and count', () => {
    expect(found()).toEqual(Object.fromEntries(Object.entries(SITES).map(([p, v]) => [p, v.n])));
  });

  it('a refusing site names the key it asks and really calls the helper', () => {
    for (const [p, v] of Object.entries(SITES)) {
      if (v.kind !== 'refuses') continue;
      const src = readFileSync(p, 'utf8');
      expect(src, p).toMatch(/requireOwnerHeadroom/);
      expect(src, p).toContain(`'${v.asks}'`);
    }
  });

  it('every entry says why', () => {
    for (const [p, v] of Object.entries(SITES)) expect(v.because.length, p).toBeGreaterThan(15);
  });
});
