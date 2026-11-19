/** #4497: teamUtilization checks its arguments BEFORE admission and before any transaction (cor:agt:060:13, Victor's FIT). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
let appId: string, memberId: string, outsiderId: string;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const capture = (f: () => Promise<unknown>) => f().then(() => null, (e: any) => ({ message: e.message, extensions: e.extensions }));

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Util4497', urn: `util4497-${generateId()}.test` } });
  memberId = (await db.user.create({ data: { handle: `um-${generateId()}` } })).id;
  outsiderId = (await db.user.create({ data: { handle: `uo-${generateId()}` } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Util4497', urn: `util4497-${generateId()}.test:team` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'member' } });
});
afterEach(() => { vi.restoreAllMocks(); });

const INVALID = [
  ['windowHours 0', { windowHours: 0 }, 'windowHours must be an integer from 1 to 168.'],
  ['windowHours 169', { windowHours: 169 }, 'windowHours must be an integer from 1 to 168.'],
  ['windowHours 1.5', { windowHours: 1.5 }, 'windowHours must be an integer from 1 to 168.'],
  ['a family that is not a token', { family: 'not a token' }, 'Invalid utilization family or tier.'],
  ['a tier outside high/mid/low', { tier: 'ultra' }, 'Invalid utilization family or tier.'],
] as const;

describe('#4497: invalid input answers one BAD_USER_INPUT for every App and never opens the roster read', () => {
  for (const [label, bad, message] of INVALID) {
    it(`${label}: identical for a readable App, an unreadable App and a missing ref, with no transaction`, async () => {
      const tx = vi.spyOn(db, '$transaction');
      const arms = {
        readable: await capture(() => Q.teamUtilization({}, { appRef: appId, ...bad }, ctx(memberId))),
        unreadable: await capture(() => Q.teamUtilization({}, { appRef: appId, ...bad }, ctx(outsiderId))),
        missing: await capture(() => Q.teamUtilization({}, { appRef: generateId(), ...bad }, ctx(memberId))),
      };
      expect(arms.readable).toEqual({ message, extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }) });
      expect(arms.unreadable).toEqual(arms.readable);
      expect(arms.missing).toEqual(arms.readable);
      expect(tx).not.toHaveBeenCalled();
    });
  }

  it('a busy store cannot turn a caller fault into the retryable TEAM_READ_BUSY', async () => {
    const busy = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });
    vi.spyOn(db, '$transaction').mockRejectedValue(busy);
    const got = await capture(() => Q.teamUtilization({}, { appRef: appId, windowHours: 0 }, ctx(memberId)));
    expect(got?.extensions).toMatchObject({ code: 'BAD_USER_INPUT' });
  });

  it('valid input still gets the roster refusal byte for byte (cor:agt:060:13)', async () => {
    const util = await capture(() => Q.teamUtilization({}, { appRef: appId }, ctx(outsiderId)));
    const roster = await capture(() => Q.teamRoster({}, { appRef: appId }, ctx(outsiderId)));
    expect(util).not.toBeNull();
    expect(util).toEqual(roster);
  });
});
