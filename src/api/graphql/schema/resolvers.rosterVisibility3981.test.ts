/** #3981: latent malformed-row hardening; the current roster producer always supplies the visibility decision. */
import { describe, expect, it } from 'vitest';
import { agentTaskMatchingFieldResolvers } from './resolvers.agentTaskMatching.js';

const availability = agentTaskMatchingFieldResolvers.TeamRosterEntry.availability;
type RosterRow = Parameters<typeof availability>[0];

const stored = {
  workerId: 'worker-3981', state: 'unavailable', reason: 'other',
  until: new Date('2026-11-12T12:00:00Z'), setAt: new Date('2026-11-11T12:00:00Z'),
  setBy: 'holder', setByUserId: 'setter-3981', setByWorkerId: null, setByHostKey: 'host-3981',
};

describe('#3981 roster setter identity requires an explicit internals decision', () => {
  it.each([
    ['absent', {}, null],
    ['false', { internalsVisible: false }, null],
    ['true', { internalsVisible: true }, stored.setByUserId],
  ] as const)('%s: preserves all availability fields except the withheld USER id', (_, decision, userId) => {
    // Deliberately bypass the row type for the absent control: no production producer omits the decision today.
    const row = { availabilityRecord: { row: { ...stored }, inEffect: false }, ...decision } as unknown as RosterRow;
    expect(availability(row)).toEqual({ ...stored, setByUserId: userId, __inEffect: false });
    expect(row.availabilityRecord!.row).toEqual(stored); // the stored provenance is never mutated by projection
  });
});
