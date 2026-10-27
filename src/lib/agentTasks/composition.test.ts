/** #2489 — deterministic ordering of already-authorized composition rows. */
import { describe, expect, it } from 'vitest';
import { groupComposition } from './composition.js';

type Row = Parameters<typeof groupComposition>[0][number];
const appUrn = 'composition.example:team';
const coordinator = (slug: string, name: string): NonNullable<Row['reportsTo']> =>
  ({ workerId: slug, slug, name, retired: false });
const row = (workerId: string, reportsTo: Row['reportsTo'], family: string | null = null): Row => ({
  appUrn, workerId, name: workerId, slug: workerId, reportsTo,
  role: 'engineer', family, bound: false, liveSession: false, state: 'AVAILABLE',
});

describe('#2489 groupComposition ordering', () => {
  it.each([false, true])('breaks lowercase-name ties by URN, with unassigned last (reverse insertion: %s)', (reverse) => {
    // Pure input intentionally allows a name tie that the database would reject.
    const a = coordinator('a-coordinator', 'alpha');
    const z = coordinator('z-coordinator', 'Alpha');
    const aRows = [row('a-second', a), row('a-first', a)];
    const zRows = [row('z-second', z), row('z-first', z)];
    const input = [row('unassigned', null), ...(reverse ? [...zRows, ...aRows] : [...aRows, ...zRows])];
    const lanes = groupComposition(input);
    expect(lanes.map((lane) => lane.coordinator?.urn ?? null)).toEqual([
      'hrn:worker:composition.example:team:a-coordinator',
      'hrn:worker:composition.example:team:z-coordinator',
      null,
    ]);
    // Lane sorting must not reorder the workers supplied within a lane.
    expect(lanes.map((lane) => lane.workers.map(({ worker }) => worker.id))).toEqual([
      ['a-second', 'a-first'], ['z-second', 'z-first'], ['unassigned'],
    ]);
  });

  it.each([false, true])('orders names before URNs (reverse insertion: %s)', (reverse) => {
    const alpha = row('alpha-worker', coordinator('z-coordinator', 'alpha'));
    const zed = row('zed-worker', coordinator('a-coordinator', 'Zed'));
    const lanes = groupComposition(reverse ? [zed, alpha] : [alpha, zed]);
    expect(lanes.map((lane) => lane.coordinator?.name)).toEqual(['alpha', 'Zed']);
  });

  it.each([
    [null, 'codex', 'claude', 'codex'],
    ['codex', 'claude', null, 'codex'],
    ['claude', null, 'codex', 'codex'],
  ])('orders same-role family counts independently of insertion order (%j)', (...families) => {
    const lanes = groupComposition(families.map((family, i) => row(`worker-${i}`, null, family)));
    expect(lanes).toHaveLength(1);
    expect(lanes[0].countsByRoleFamily).toEqual([
      { role: 'engineer', family: 'claude', count: 1 },
      { role: 'engineer', family: 'codex', count: 2 },
      { role: 'engineer', family: null, count: 1 },
    ]);
  });
});
