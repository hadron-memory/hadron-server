import { afterEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { HttpEmbeddingClient } from '../../../lib/embedding/client.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { resolvers, type Context } from './resolvers.js';

afterEach(() => { resetEmbeddingClientForTests(); vi.unstubAllEnvs(); });

it('a real query-client cancellation preserves hybrid keyword hits and degradation #439', async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'deadline-org', graphName: 'deadline/graph' });
  await db.memory.update({ where: { id: graph.id }, data: { vectorIndexEnabled: true } });
  const id = generateId();
  await db.node.create({ data: { id, memoryId: graph.id, loc: 'retention', name: 'retention', content: 'retention policy' } });
  vi.stubEnv('EMBEDDING_API_URL', 'http://synthetic.invalid');
  let seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen = JSON.parse(String(init?.body)).input;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  setEmbeddingClientForTests(new HttpEmbeddingClient({ url: 'http://synthetic.invalid', model: 'synthetic', dim: 768, queryTimeoutMs: 30, fetchImpl }));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (resolvers.Query as any).findNodes(null, { query: 'retention', mode: 'hybrid', filter: { memoryIds: [graph.id] } }, { db, roles: ['ADMIN'], userId: 'deadline-admin' } as Context),
      new Promise(r => { watchdog = setTimeout(() => r('UNSETTLED'), 800); }),
    ]);
    expect(result).not.toBe('UNSETTLED');
    expect(result.hits.map((h: any) => h.node.id)).toContain(id);
    expect(result.degraded).toContain('embedding_unavailable');
    expect(seen).toEqual(['search_query: retention']);
  } finally { clearTimeout(watchdog); }
});
