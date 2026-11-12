/** #4035: the pure decision, every outcome, including the "stage list unreadable" and empty-list cases. */
import { describe, it, expect } from 'vitest';
import { decideNextStage } from './nextStage.js';

const order = ['a', 'b'];

describe('decideNextStage (#4035)', () => {
  it('null, undefined and empty name no stage', () => {
    for (const v of [null, undefined, '']) expect(decideNextStage(v, 'a', order)).toEqual({ kind: 'none' });
  });
  it('a non-string name is rejected under its string form', () => {
    expect(decideNextStage(5, 'a', order)).toEqual({ kind: 'rejected', name: '5' });
  });
  it('the current stage stays, even when the list is null or empty', () => {
    for (const o of [order, null, []]) expect(decideNextStage('a', 'a', o)).toEqual({ kind: 'stay' });
  });
  it('a listed stage moves; an unlisted one is rejected', () => {
    expect(decideNextStage('b', 'a', order)).toEqual({ kind: 'move', stage: 'b' });
    expect(decideNextStage('z', 'a', order)).toEqual({ kind: 'rejected', name: 'z' });
  });
  it('an unreadable list (null) takes the name as before; an empty list rejects every other name', () => {
    expect(decideNextStage('z', 'a', null)).toEqual({ kind: 'move', stage: 'z' });
    expect(decideNextStage('z', 'a', [])).toEqual({ kind: 'rejected', name: 'z' });
  });
  it('no current stage: a listed name moves', () => {
    expect(decideNextStage('a', undefined, order)).toEqual({ kind: 'move', stage: 'a' });
  });
});
