/**
 * #2020 — the reach rule and its SQL twin agree row for row.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { mentionReach, mentionReachSql, reachEnvelopeOf, reachesWorker } from './mentionReach.js';

const ROWS: unknown[] = [
  { mentions: ['liam'] },
  { mentions: ['rook'] },
  { mentions: ['all'] },
  { mentions: ['all'], broadcastWakes: true },
  { mentions: ['team'], broadcastWakes: true },
  { mentions: ['team.all'], broadcastWakes: true },
  { mentions: ['all'], broadcastWakes: 'true' },
  { mentions: ['all'], broadcastWakes: null },
  { mentions: ['all'], broadcastWakes: false },
  { mentions: 'all', broadcastWakes: true },
  { mentions: [1, 'all'], broadcastWakes: true },
  { mentions: ['liam', 'all'] },
  { broadcastWakes: true },
  {},
  null,
  'garbage',
  [],
];

describe('mentionReach', () => {
  it('a name is direct; a broadcast reaches only with a strictly boolean stamp; @team.all is no broadcast yet', () => {
    const r = (d: unknown) => mentionReach(reachEnvelopeOf(d), ['liam']);
    expect(ROWS.map(r)).toEqual([
      'direct', null, null, 'broadcast', 'broadcast', null, null, null, null, null, 'broadcast', 'direct', null, null, null, null, null,
    ]);
  });

  it('a worker\'s own post never reaches it; a human\'s post is nobody\'s own', () => {
    const stamped = { mentions: ['all'], broadcastWakes: true };
    expect(reachesWorker(reachEnvelopeOf({ ...stamped, authorWorkerId: 'w1' }), ['w1'], ['liam'])).toBe(false);
    expect(reachesWorker(reachEnvelopeOf({ ...stamped, authorWorkerId: 'w2' }), ['w1'], ['liam'])).toBe(true);
    expect(reachesWorker(reachEnvelopeOf(stamped), ['w1'], ['liam'])).toBe(true);
    expect(reachesWorker(reachEnvelopeOf({ mentions: ['liam'], authorWorkerId: 'w1' }), ['w1'], ['liam'])).toBe(false);
  });
});

describe('mentionReachSql', () => {
  it('agrees with mentionReach on every row, with and without tokens', async () => {
    for (const tokens of [['liam'], [], ['liam', 'rook']]) {
      const values = Prisma.join(ROWS.map((d, i) => Prisma.sql`(${i}::int, ${JSON.stringify(d)}::jsonb)`));
      const got = await db.$queryRaw<Array<{ i: number; hit: boolean | null }>>(Prisma.sql`
        SELECT i, ${mentionReachSql(Prisma.sql`d`, Prisma.sql`${tokens}::text[]`)} AS hit
        FROM (VALUES ${values}) AS v(i, d) ORDER BY i`);
      const sql = got.map((r) => r.hit === true);
      const js = ROWS.map((d) => mentionReach(reachEnvelopeOf(d), tokens) !== null);
      expect(sql, `tokens ${JSON.stringify(tokens)}`).toEqual(js);
    }
  });
});
