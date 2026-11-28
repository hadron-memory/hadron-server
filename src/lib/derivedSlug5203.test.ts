// #5203 S3 — the worker and ticker slug helpers already iterate on a taken slug and fall back on a name that yields
// none; they also passed a reserved word through (hrn:node:hadronmemory.com:specs:cor:urn:010:01). A reserved word
// is now skipped like a taken one, case-insensitively, so a worker named "Task" never stores the atom `task`.
import { describe, expect, it } from 'vitest';
import { isValidSlug } from './urn.js';
import { nextFreeWorkerSlug } from './workerSlug.js';
import { nextFreeTickerSlug } from './tickers/tickerSlug.js';

const workerDb = (taken: string[]) =>
  ({ worker: { findMany: async () => taken.map((slug) => ({ slug })) } }) as Parameters<typeof nextFreeWorkerSlug>[0];
const tickerDb = (taken: string[]) =>
  ({ ticker: { findMany: async () => taken.map((slug) => ({ slug })) } }) as Parameters<typeof nextFreeTickerSlug>[0];

const helpers: [string, (taken: string[], name: string) => Promise<string>][] = [
  ['nextFreeWorkerSlug', (taken, name) => nextFreeWorkerSlug(workerDb(taken), 'app', name)],
  ['nextFreeTickerSlug', (taken, name) => nextFreeTickerSlug(tickerDb(taken), 'app', name)],
];

for (const [helper, next] of helpers) {
  describe(`#5203 S3 ${helper}`, () => {
    it('never returns a reserved word, matched case-insensitively', async () => {
      for (const name of ['Task', 'agent', 'MEMORY', 'Agent:']) {
        const slug = await next([], name);
        expect(isValidSlug(slug)).toBe(true);
      }
    });

    it('skips a reserved base and then a taken candidate in turn', async () => {
      expect(await next([], 'Task')).toBe('task-2');
      expect(await next(['task-2'], 'Task')).toBe('task-3');
    });

    it('leaves an ordinary name unchanged', async () => {
      expect(await next([], 'Iris')).toBe('iris');
    });
  });
}
