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
  it.each([
    { reverse: false, aName: 'alpha', zName: 'Alpha' },
    { reverse: true, aName: 'alpha', zName: 'Alpha' },
    { reverse: false, aName: 'Alpha', zName: 'alpha' },
    { reverse: true, aName: 'Alpha', zName: 'alpha' },
  ])('breaks lowercase-name ties by URN ($aName / $zName; reverse: $reverse)', ({ reverse, aName, zName }) => {
    // Pure input intentionally allows a name tie that the database would reject.
    const a = coordinator('a-coordinator', aName);
    const z = coordinator('z-coordinator', zName);
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
    { families: [null, 'codex', 'claude', 'codex'] },
    { families: ['codex', 'claude', null, 'codex'] },
    { families: ['claude', null, 'codex', 'codex'] },
  ])('orders same-role family counts independently of insertion order ($families)', ({ families }) => {
    const lanes = groupComposition(families.map((family, i) => row(`worker-${i}`, null, family)));
    expect(lanes).toHaveLength(1);
    expect(lanes[0].countsByRoleFamily).toEqual([
      { role: 'engineer', family: 'claude', count: 1 },
      { role: 'engineer', family: 'codex', count: 2 },
      { role: 'engineer', family: null, count: 1 },
    ]);
  });

  it('returns no lanes for empty input', () => {
    expect(groupComposition([])).toEqual([]);
  });

  it.each([false, true])('orders role buckets and role-family pairs with null last (reverse: %s)', (reverse) => {
    const input = [
      { ...row('z-codex', null, 'codex'), role: 'z-role' },
      { ...row('no-role', null, 'claude'), role: null },
      { ...row('a-null', null), role: 'a-role' },
      { ...row('a-codex-1', null, 'codex'), role: 'a-role' },
      { ...row('a-claude', null, 'claude'), role: 'a-role' },
      { ...row('a-codex-2', null, 'codex'), role: 'a-role' },
      { ...row('no-role-no-family', null), role: null },
    ];
    const before = structuredClone(input);
    const lanes = groupComposition(reverse ? [...input].reverse() : input);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].coordinator).toBeNull();
    expect(lanes[0].coordinatorRetired).toBe(false);
    expect(lanes[0].workers.map(({ worker }) => worker.id)).toEqual(reverse
      ? ['no-role-no-family', 'a-codex-2', 'a-claude', 'a-codex-1', 'a-null', 'no-role', 'z-codex']
      : ['z-codex', 'no-role', 'a-null', 'a-codex-1', 'a-claude', 'a-codex-2', 'no-role-no-family']);
    expect(lanes[0].countsByRole).toEqual([
      { role: 'a-role', count: 4 },
      { role: 'z-role', count: 1 },
      { role: null, count: 2 },
    ]);
    expect(lanes[0].countsByRoleFamily).toEqual([
      { role: 'a-role', family: 'claude', count: 1 },
      { role: 'a-role', family: 'codex', count: 2 },
      { role: 'a-role', family: null, count: 1 },
      { role: 'z-role', family: 'codex', count: 1 },
      { role: null, family: 'claude', count: 1 },
      { role: null, family: null, count: 1 },
    ]);
    expect(input).toEqual(before);
  });

  it('projects retired coordinators and worker status without extra row fields', () => {
    const boss = { ...coordinator('retired-boss', 'Former Boss'), retired: true, privateField: 'not projected' };
    const input = [{ ...row('worker-one', boss, 'codex'), name: 'One', bound: true,
      liveSession: true, state: 'WORKING' as const, privateField: 'not projected' }];
    expect(groupComposition(input)).toEqual([{
      coordinator: { kind: 'WORKER', id: 'retired-boss', name: 'Former Boss',
        urn: 'hrn:worker:composition.example:team:retired-boss' },
      coordinatorRetired: true,
      workers: [{ worker: { kind: 'WORKER', id: 'worker-one', name: 'One',
        urn: 'hrn:worker:composition.example:team:worker-one' },
        role: 'engineer', family: 'codex', bound: true, liveSession: true, state: 'WORKING' }],
      countsByRole: [{ role: 'engineer', count: 1 }],
      countsByRoleFamily: [{ role: 'engineer', family: 'codex', count: 1 }],
    }]);
  });

});
