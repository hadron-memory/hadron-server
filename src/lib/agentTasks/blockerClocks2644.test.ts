/** #2644: blocked intervals never age any of the four independent clocks. */
import { describe, expect, it } from 'vitest';
import { stallCandidates, STALL_WINDOW_DEFAULTS, type StallInputs } from './stall.js';
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 29, 10, minutes));
function input(status: string, assigned = true): StallInputs {
  return { task: { id: 'task', appId: 'app', status, parentTaskId: null, ownerWorkerId: null, ownerUserId: 'owner',
    assigneeWorkerId: assigned ? 'worker' : null, assigneeUserId: null, assignedAt: assigned ? at(0) : null,
    startedAt: status === 'started' ? at(0) : null, createdAt: at(0), startBy: at(1), releasedAt: at(30), blocked: false },
    openChildCount: 0, lastChildEndedAt: null, lastProgressAt: null, assigneeActivityAt: null, queuedAt: at(0),
    endedChildren: [{ id: 'child', endedAt: at(2), ownerWorkerId: 'worker', ownerActivityAt: null }] };
}
describe('#2644 release-floored clocks', () => {
  it('suppresses all four rules when blocked, including an existing episode', () => {
    for (const status of ['pending', 'started']) for (const assigned of [false, true]) {
      const i = input(status, assigned); i.task.blocked = true;
      expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(180))).toEqual([]);
      expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(180), { episodesRunning: true })).toEqual([]);
    }
  });
  it('floors assignment and past startBy at release, without granting an immediate overdue alarm', () => {
    const i = input('pending'); i.endedChildren = [];
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(44))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(45))).toMatchObject([{ rule: 'not-started', episodeStart: at(30), dueAt: at(45) }]);
    i.task.startBy = at(50);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(49))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(50))[0].dueAt).toEqual(at(50));
  });
  it('floors queued, progress and owner-reaction independently and respects later activity', () => {
    const queued = input('pending', false);
    expect(stallCandidates(queued, STALL_WINDOW_DEFAULTS, at(59))).toEqual([]);
    expect(stallCandidates(queued, STALL_WINDOW_DEFAULTS, at(60))[0]).toMatchObject({ rule: 'unassignable', episodeStart: at(30) });
    const progress = input('started'); progress.endedChildren = [];
    expect(stallCandidates(progress, STALL_WINDOW_DEFAULTS, at(89))).toEqual([]);
    expect(stallCandidates(progress, STALL_WINDOW_DEFAULTS, at(90))[0]).toMatchObject({ rule: 'no-progress', episodeStart: at(30) });
    progress.assigneeActivityAt = at(40);
    expect(stallCandidates(progress, STALL_WINDOW_DEFAULTS, at(99))).toEqual([]);
    const reaction = input('pending');
    expect(stallCandidates(reaction, STALL_WINDOW_DEFAULTS, at(49)).some((c) => c.rule === 'owner-unreactive')).toBe(false);
    expect(stallCandidates(reaction, STALL_WINDOW_DEFAULTS, at(50)).find((c) => c.rule === 'owner-unreactive')).toMatchObject({ episodeStart: at(30) });
  });
  it('each repeated release starts a distinct episode', () => {
    const i = input('pending', false); i.task.releasedAt = at(90);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(119))).toEqual([]);
    expect(stallCandidates(i, STALL_WINDOW_DEFAULTS, at(120))[0]).toMatchObject({ episodeStart: at(90) });
  });
});
