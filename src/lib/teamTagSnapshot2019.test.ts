import { describe, expect, it } from 'vitest';
import { buildTeamSnapshot, teamTagsEnabled, reservedTeamPrefix } from './teamTagSnapshot.js';

const workers = [
  { id: 'head', name: 'Head', reportsToWorkerId: null, retiredAt: null },
  { id: 'child', name: 'Child', reportsToWorkerId: 'head', retiredAt: null },
  { id: 'nested', name: 'Nested', reportsToWorkerId: 'head', retiredAt: null },
  { id: 'leaf', name: 'Leaf', reportsToWorkerId: 'nested', retiredAt: null },
  { id: 'solo', name: 'Solo', reportsToWorkerId: null, retiredAt: null },
  { id: 'retired', name: 'Retired', reportsToWorkerId: 'head', retiredAt: new Date() },
];

describe('S3 dark mode and immutable team snapshot', () => {
  it('defaults OFF and preserves the unconditional bare-name validation split', () => {
    expect(teamTagsEnabled(undefined)).toBe(false);
    expect(teamTagsEnabled('false')).toBe(false);
    expect(teamTagsEnabled('true')).toBe(true);
    expect(reservedTeamPrefix('TEAM.Head', false)).toBe(false);
    expect(reservedTeamPrefix('TEAM.Head', true)).toBe(true);
    expect(reservedTeamPrefix('team', true)).toBe(false);
  });
  it('stamps nearest teams of sender and mentions without expanding display tags into reach', () => {
    expect(buildTeamSnapshot(workers, 'child', ['leaf'])).toEqual({
      teamTagsVersion: 1,
      teamTags: [{ headId: 'head', label: '@team.head' }, { headId: 'nested', label: '@team.nested' }],
      teamHeadIds: ['head', 'nested'], teamBroadcastWorkerIds: [],
    });
  });
  it('allows an outside author to address a subtree, excludes retired workers and never adds global reach', () => {
    const snapshot = buildTeamSnapshot(workers, 'solo', ['team.head.all', 'all']);
    expect(snapshot.teamBroadcastWorkerIds).toEqual(['child', 'head', 'leaf', 'nested']);
    expect(snapshot.teamHeadIds).toEqual(['head']);
    expect(snapshot).not.toHaveProperty('broadcastWakes');
  });
  it('resolves relative nearest team; teamless relative and invalid explicit heads have one non-oracular refusal', () => {
    expect(buildTeamSnapshot(workers, 'leaf', ['team.all']).teamBroadcastWorkerIds).toEqual(['leaf', 'nested']);
    for (const token of ['team.all', 'team.missing.all', 'team.retired.all', 'team.solo.all']) {
      expect(() => buildTeamSnapshot(workers, 'solo', [token])).toThrow('Team broadcast target is unavailable in this Channel.');
    }
  });
  it('refuses token-colliding heads as a whole and leaves explicit no-team snapshots empty', () => {
    const collision = [...workers, { id: 'other', name: 'HEAD', reportsToWorkerId: null, retiredAt: null },
      { id: 'other-child', name: 'Other Child', reportsToWorkerId: 'other', retiredAt: null }];
    expect(() => buildTeamSnapshot(collision, 'child', ['team.head.all'])).toThrow();
    expect(buildTeamSnapshot(workers, 'solo', [])).toEqual({teamTagsVersion: 1, teamTags: [], teamHeadIds: [], teamBroadcastWorkerIds: []});
  });
});

it('does not forge tags from literal tag text, import foreign authors, or climb past a retired immediate head', () => {
  expect(buildTeamSnapshot(workers, 'foreign-worker', ['team.head'])).toMatchObject({teamTags:[],teamBroadcastWorkerIds:[]});
  const retiredHead = workers.map(w=>w.id==='head'?{...w,retiredAt:new Date()}:w);
  expect(buildTeamSnapshot(retiredHead,'child',[]).teamTags).toEqual([]);
  expect(buildTeamSnapshot(workers,'child',['retired']).teamHeadIds).toEqual(['head']);
});
