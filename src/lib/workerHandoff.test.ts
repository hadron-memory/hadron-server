/**
 * #1029 — the handoff address convention and the continuity states.
 *
 * These are the parts that must not drift: the loc IS the ordering (seq cannot
 * hold a timestamp), and the three statuses are what make a reaped stint
 * degrade honestly rather than silently handing over stale prose.
 */

import { describe, it, expect } from 'vitest';
import {
  handoffLocFor,
  handoffSessionId,
  continuityStatusOf,
  renderWorkerContinuity,
  nextHandoffLoc,
  HANDOFF_SESSION_KEY,
} from './workerHandoff.js';

describe('handoffLocFor — the loc carries the ordering', () => {
  it('formats handoffs:<yyyy-mm-dd>-<hhmm> in UTC', () => {
    expect(handoffLocFor(new Date('2026-08-18T10:30:59.123Z'))).toBe('handoffs:2026-08-18-1030');
  });

  it('sorts lexically in chronological order — including across a year boundary', () => {
    const locs = [
      new Date('2027-01-01T00:00:00Z'),
      new Date('2026-08-18T09:05:00Z'),
      new Date('2026-12-31T23:59:00Z'),
      new Date('2026-08-18T10:30:00Z'),
    ].map(handoffLocFor);
    expect([...locs].sort()).toEqual([
      'handoffs:2026-08-18-0905',
      'handoffs:2026-08-18-1030',
      'handoffs:2026-12-31-2359',
      'handoffs:2027-01-01-0000',
    ]);
  });

  it('the timestamp it encodes would overflow Node.seq — which is why it is in the loc', () => {
    // The trap this convention exists to avoid: seq is a 32-bit signed Int and
    // a yyyymmddhhmm value does not fit. Asserted so nobody "simplifies" the
    // ordering back into seq.
    expect(202608181030).toBeGreaterThan(2_147_483_647);
  });
});

describe('handoffSessionId — the envelope that separates current from stale', () => {
  it('reads the writing session id', () => {
    expect(handoffSessionId({ [HANDOFF_SESSION_KEY]: 'sess-1' })).toBe('sess-1');
  });
  it('is null for a hand-written handoff, so it reads as MISSING rather than CURRENT', () => {
    // The prototype handoffs predate this write path. Claiming one as the
    // previous stint's would be an attestation the platform cannot make.
    expect(handoffSessionId({ note: 'written by hand' })).toBeNull();
    expect(handoffSessionId(null)).toBeNull();
    expect(handoffSessionId('not an object')).toBeNull();
  });
});

describe('continuityStatusOf', () => {
  it('FIRST_STINT when no previous ended session — an absence that is not a gap', () => {
    expect(continuityStatusOf({ previousSessionId: null, handoffSessionId: null })).toBe('FIRST_STINT');
    expect(continuityStatusOf({ previousSessionId: null, handoffSessionId: 'x' })).toBe('FIRST_STINT');
  });
  it('CURRENT only when the previous session wrote the newest handoff', () => {
    expect(continuityStatusOf({ previousSessionId: 's1', handoffSessionId: 's1' })).toBe('CURRENT');
  });
  it('MISSING when the previous stint left none — including when an older one exists', () => {
    expect(continuityStatusOf({ previousSessionId: 's2', handoffSessionId: 's1' })).toBe('MISSING');
    expect(continuityStatusOf({ previousSessionId: 's2', handoffSessionId: null })).toBe('MISSING');
  });
});

describe('renderWorkerContinuity — what the agent actually reads', () => {
  const handoff = {
    loc: 'handoffs:2026-08-18-1030',
    content: 'PR #1042 open, awaiting review.',
    createdAt: new Date('2026-08-18T10:30:00Z'),
  };

  it('says nothing on a first stint with no handoff', () => {
    expect(renderWorkerContinuity({ status: 'FIRST_STINT', handoff: null, previousSession: null })).toBe('');
    expect(renderWorkerContinuity(null)).toBe('');
  });

  it('hands over a CURRENT handoff with its provenance', () => {
    const out = renderWorkerContinuity({
      status: 'CURRENT',
      handoff,
      previousSession: { id: 's1', endedAt: new Date('2026-08-18T10:31:00Z'), autoExpiredAt: null },
    });
    expect(out).toContain('Handoff from the previous session');
    expect(out).toContain('handoffs:2026-08-18-1030');
    expect(out).toContain('PR #1042 open');
    expect(out).not.toContain('⚠');
  });

  it('names an AUTO-EXPIRED stint as such, before the stale content', () => {
    // The honesty criterion. "Nobody wrote this down" and "the server reaped it
    // mid-task" lead a successor to different next steps, so the render must
    // distinguish them — and the caveat must come FIRST, because an agent that
    // reads prose then a caveat has already started acting on the prose.
    const out = renderWorkerContinuity({
      status: 'MISSING',
      handoff,
      previousSession: {
        id: 'sess-90ff3aad',
        endedAt: new Date('2026-08-18T06:50:46Z'),
        autoExpiredAt: new Date('2026-08-18T06:50:46Z'),
      },
    });
    expect(out).toContain('auto-expired by the server');
    expect(out).toContain('OLDER than that stint');
    expect(out).toContain('history, not as the current state of play');
    expect(out.indexOf('No current handoff')).toBeLessThan(out.indexOf('PR #1042 open'));
  });

  it('distinguishes a clean end that skipped a handoff from a reap', () => {
    const out = renderWorkerContinuity({
      status: 'MISSING',
      handoff: null,
      previousSession: { id: 's9', endedAt: new Date('2026-08-18T12:00:00Z'), autoExpiredAt: null },
    });
    expect(out).toContain('without writing one');
    expect(out).not.toContain('auto-expired');
    expect(out).toContain('no earlier handoff either');
  });
});

describe('nextHandoffLoc — the collision suffix must not break the ordering', () => {
  /**
   * Stubbed `findFirst` — the function only needs "is this loc taken?", so this
   * exercises the REAL allocator without a database.
   */
  const dbWith = (taken: Set<string>) => ({
    node: {
      // loc-scope-ok: a stub, not a query — the real call site scopes by memoryId.
      findFirst: async ({ where }: { where: { loc: string } }) =>
        (taken.has(where.loc) ? { id: 'x' } : null),
    },
  }) as unknown as Parameters<typeof nextHandoffLoc>[0];

  const at = new Date('2026-08-18T10:30:00Z');
  const base = 'handoffs:2026-08-18-1030';

  it('returns the bare loc when the minute is free', async () => {
    expect(await nextHandoffLoc(dbWith(new Set()), 'mem', at)).toBe(base);
  });

  it('keeps every allocated loc in lexical order past the ninth collision (Codex P2)', async () => {
    // Unpadded, "-10" sorts BEFORE "-9", so `newestHandoff`'s ORDER BY loc DESC
    // returns the ninth collision instead of the newest — a correctness bug in
    // the ordering contract that only appears once ten land in one minute.
    //
    // Allocate 12 in sequence through the real function, feeding each result
    // back as taken, then assert the sequence is already sorted.
    const taken = new Set<string>();
    const allocated: string[] = [];
    for (let i = 0; i < 12; i++) {
      const loc = await nextHandoffLoc(dbWith(taken), 'mem', at);
      allocated.push(loc);
      taken.add(loc);
    }
    expect(allocated).toHaveLength(12);
    expect([...allocated].sort()).toEqual(allocated);
    // And the tenth-and-later are the ones that would have broken it.
    expect(allocated[9]).toBe(`${base}-10`);
    expect(allocated[8] < allocated[9]).toBe(true);
  });

  it('fails loudly rather than spinning when the minute is exhausted', async () => {
    const taken = new Set([base, ...Array.from({ length: 49 }, (_, i) => `${base}-${String(i + 2).padStart(2, '0')}`)]);
    await expect(nextHandoffLoc(dbWith(taken), 'mem', at)).rejects.toThrow(/50 already exist/);
  });
});
