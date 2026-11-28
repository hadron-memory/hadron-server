/**
 * #5011 (Billing A4): the pure ledger replay behind grant expiry.
 *
 * hrn:node:hadronmemory.com:specs:cor:dmo:170:10 (free credit expires; one settling entry per grant, also for a fully
 * used grant) and hrn:node:hadronmemory.com:specs:cor:dmo:170:11 (spend draws on the soonest-expiring credit first and
 * on credit that never expires last). The ledgers L1-L7 and the 20,000-ledger property are the plan's review
 * (hrn:node:hadronmemory.com:hadron-server:design:subscription-billing-plan:review-rev11, Part 3). Dates are 2027,
 * 00:00 UTC.
 *
 * Red on main: `./expiry.js` does not exist (an import failure for the whole file).
 */
import { describe, it, expect } from 'vitest';
import { replayLedger, replayWindowStart, type ReplayEntry } from './expiry.js';

const d = (s: string) => new Date(`2027-${s}T00:00:00.000Z`);

let seq = 0;
const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(6, '0')}`;

function grant(id: string, amount: number, created: Date, expires?: Date): ReplayEntry {
  return {
    id,
    kind: 'grant',
    amountMicroCents: BigInt(amount),
    expiresAt: expires ?? null,
    sourceType: 'test-grant',
    sourceId: id,
    createdAt: created,
  };
}
function debit(amount: number, created: Date, id = nextId('d')): ReplayEntry {
  return {
    id,
    kind: 'debit',
    amountMicroCents: -BigInt(amount),
    expiresAt: null,
    sourceType: 'usage-event',
    sourceId: id,
    createdAt: created,
  };
}
function adjustment(amount: number, created: Date, sourceType: string, sourceId: string, id = nextId('a')): ReplayEntry {
  return { id, kind: 'adjustment', amountMicroCents: BigInt(amount), expiresAt: null, sourceType, sourceId, createdAt: created };
}
const settlement = (grantId: string, amount: bigint, created: Date, id = nextId('s')): ReplayEntry => ({
  id,
  kind: 'adjustment',
  amountMicroCents: amount,
  expiresAt: null,
  sourceType: 'grant-expiry',
  sourceId: grantId,
  createdAt: created,
});

const sum = (entries: ReplayEntry[]) => entries.reduce((acc, e) => acc + e.amountMicroCents, 0n);
const settleMap = (r: ReturnType<typeof replayLedger>) =>
  Object.fromEntries(r.toSettle.map((s) => [s.grantId, s.remaining]));

/**
 * What the settlement module does against the database, done here on an array: the window from the owner's expiring
 * grants and the settled ids, one opening figure for everything before it, the replay of the rest.
 */
function windowedReplay(entries: ReplayEntry[], now: Date) {
  const visible = entries.filter((e) => e.createdAt <= now);
  const expiring = visible.filter((e) => e.kind === 'grant' && e.expiresAt !== null);
  const settled = new Set(visible.filter((e) => e.sourceType === 'grant-expiry').map((e) => e.sourceId as string));
  const start = replayWindowStart(
    expiring.map((g) => ({ id: g.id, createdAt: g.createdAt, expiresAt: g.expiresAt as Date })),
    settled,
  );
  if (start === null) return { start, result: null };
  const opening = sum(visible.filter((e) => e.createdAt < start));
  const windowed = visible.filter((e) => e.createdAt >= start);
  return { start, result: replayLedger(windowed, now, { opening, settled }) };
}

/** A read at `now`: settle every grant the windowed replay names, appending the settlement entries. */
function settleAt(entries: ReplayEntry[], now: Date): ReplayEntry[] {
  const { result } = windowedReplay(entries, now);
  const written = (result?.toSettle ?? []).map((s) => settlement(s.grantId, -s.remaining, now));
  entries.push(...written);
  return written;
}

describe('#5011 replayLedger', () => {
  it('P1: grant 100, debit 30, expiry passes: 70 to settle; once settled, nothing', () => {
    const g = grant('g1', 100, d('01-01'), d('02-01'));
    const entries = [g, debit(30, d('01-10'))];
    expect(settleMap(replayLedger(entries, d('02-02')))).toEqual({ g1: 70n });
    entries.push(settlement('g1', -70n, d('02-02')));
    expect(replayLedger(entries, d('02-03')).toSettle).toEqual([]);
  });

  it('P2 (L1): overlapping grants drain soonest-first; a debit larger than the first takes the rest from the next', () => {
    const entries = [
      grant('GA', 100, d('01-01'), d('02-01')),
      grant('GB', 100, d('01-10'), d('01-25')),
      grant('GC', 100, d('01-15'), d('02-15')),
      debit(30, d('01-05')),
      debit(50, d('01-12')),
      debit(120, d('01-20')),
      debit(40, d('01-26')),
    ];
    const mid = replayLedger(entries, new Date('2027-01-20T12:00:00.000Z'));
    // The 120 debit spans GB (50) and GA (70) before any credit that never expires: GA and GB are at 0, left out.
    expect(mid.expiring.map((e) => [e.grantId, e.remaining])).toEqual([['GC', 100n]]);
    expect(mid.permanent).toBe(0n);
    const end = replayLedger(entries, d('02-16'));
    expect(settleMap(end)).toEqual({ GB: 0n, GA: 0n, GC: 60n });
    // Settling every grant leaves the balance at 0.
    expect(sum(entries) - 60n).toBe(0n);
  });

  it('P3 (acceptance 3): G0 settled -40 on 1 Feb; on 16 Feb the windowed replay settles G1 -100, not -40', () => {
    const entries = [
      grant('G0', 100, d('01-01'), d('02-01')),
      grant('G1', 100, d('01-15'), d('02-15')),
      debit(60, d('01-20')),
    ];
    expect(settleAt(entries, d('02-01')).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([['G0', -40n]]);
    const { start } = windowedReplay(entries, d('02-16'));
    // G0 is settled, but it was live when G1 was created: the window moves back to G0's creation.
    expect(start).toEqual(d('01-01'));
    expect(settleAt(entries, d('02-16')).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([['G1', -100n]]);
  });

  it('P4 (L7, acceptance 4): equal expiries settle -40 and -100 whatever the input order', () => {
    const ga = grant('GA', 100, d('01-01'), d('02-01'));
    const gb = grant('GB', 100, d('01-02'), d('02-01'));
    const dbt = debit(60, d('01-20'));
    for (const order of [[ga, gb, dbt], [dbt, gb, ga], [gb, dbt, ga]]) {
      const r = replayLedger(order, d('02-02'));
      expect(settleMap(r)).toEqual({ GA: 40n, GB: 100n });
      expect(r.toSettle.map((s) => s.grantId)).toEqual(['GA', 'GB']);
    }
    // Same expiry AND same creation instant: the id decides, never the input order.
    const ha = grant('HA', 100, d('01-01'), d('02-01'));
    const hb = grant('HB', 100, d('01-01'), d('02-01'));
    const hd = debit(60, d('01-20'));
    for (const order of [[ha, hb, hd], [hb, ha, hd], [hd, hb, ha]]) {
      expect(settleMap(replayLedger(order, d('02-02')))).toEqual({ HA: 40n, HB: 100n });
    }
  });

  it('P5 (L2): a debit at the expiry instant does not draw on that grant; at that instant the grant is to settle', () => {
    const entries = [grant('G', 100, d('01-01'), d('02-01')), debit(30, d('01-10')), debit(20, d('02-01'))];
    const r = replayLedger(entries, d('02-01'));
    expect(settleMap(r)).toEqual({ G: 70n });
    expect(r.expiring).toEqual([]);
    expect(r.permanent).toBe(-20n);
  });

  it('P6: a debit written after expiry, before settlement, leaves the remainder untouched', () => {
    const entries = [grant('G', 100, d('01-01'), d('02-01')), debit(30, d('01-20')), debit(50, d('02-03'))];
    const r = replayLedger(entries, d('02-09'));
    expect(settleMap(r)).toEqual({ G: 70n });
    expect(r.permanent).toBe(-50n);
  });

  it('P7 (L4): an adjustment that is not a settlement changes only the credit that never expires', () => {
    const l4 = [
      grant('F', 50, d('01-01'), d('02-01')),
      grant('P', 100, d('01-02')),
      debit(80, d('01-05')),
      adjustment(-100, d('01-10'), 'refund', 'r1'),
      debit(10, d('01-12')),
    ];
    const r4 = replayLedger(l4, d('02-02'));
    expect(settleMap(r4)).toEqual({ F: 0n });
    expect(r4.permanent).toBe(-40n);

    // A positive adjustment while an expiring grant is live.
    const up = [grant('G', 100, d('01-01'), d('02-01')), adjustment(40, d('01-05'), 'credit', 'c1'), debit(30, d('01-10'))];
    const ru = replayLedger(up, d('01-15'));
    expect(ru.expiring.map((e) => [e.grantId, e.remaining])).toEqual([['G', 70n]]);
    expect(ru.permanent).toBe(40n);

    // A refund while an expiring grant still holds credit.
    const down = [grant('G', 100, d('01-01'), d('02-01')), grant('P', 100, d('01-02')), adjustment(-50, d('01-05'), 'refund', 'r2')];
    const rd = replayLedger(down, d('01-15'));
    expect(rd.expiring.map((e) => [e.grantId, e.remaining])).toEqual([['G', 100n]]);
    expect(rd.permanent).toBe(50n);
  });

  it('P8: a fully used grant is listed to settle with 0; after a zero settlement, not again', () => {
    const entries = [grant('G', 100, d('01-01'), d('02-01')), debit(100, d('01-10'))];
    expect(settleMap(replayLedger(entries, d('02-02')))).toEqual({ G: 0n });
    entries.push(settlement('G', 0n, d('02-02')));
    expect(replayLedger(entries, d('02-03')).toSettle).toEqual([]);
  });

  it('P9: a grant with no expiry is never expiring and never settled', () => {
    const entries = [grant('P', 100, d('01-01')), grant('G', 100, d('01-02'), d('02-01')), debit(30, d('01-10'))];
    for (const at of [d('01-05'), d('02-01'), d('12-31')]) {
      const r = replayLedger(entries, at);
      expect(r.expiring.map((e) => e.grantId)).not.toContain('P');
      expect(r.toSettle.map((e) => e.grantId)).not.toContain('P');
    }
    expect(replayWindowStart([], new Set())).toBeNull();
  });

  it('P10 (L3, L6): a negative permanent bucket and a purchase; six months of overlapping grants', () => {
    const l3 = [
      grant('P1', 100, d('01-01')),
      debit(150, d('01-05')),
      grant('F', 100, d('02-01'), d('03-01')),
      debit(30, d('02-09')),
      grant('P2', 200, d('02-14')),
      debit(100, d('02-19')),
    ];
    const r3 = replayLedger(l3, d('03-02'));
    expect(settleMap(r3)).toEqual({ F: 0n });
    expect(r3.permanent).toBe(120n);

    const l6: ReplayEntry[] = [];
    for (let m = 1; m <= 6; m++) {
      const mm = String(m).padStart(2, '0');
      const next = String(m + 1).padStart(2, '0');
      l6.push(grant(`D${m}`, 100, d(`${mm}-01`), d(`${next}-01`)));
      l6.push(grant(`L${m}`, 100, d(`${mm}-15`), d(`${next}-15`)));
      l6.push(debit(60, d(`${mm}-20`)));
    }
    l6.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const all = [...l6];
    const ledger: ReplayEntry[] = [];
    const reads = ['01-25', '02-02', '02-16', '03-02', '03-16', '04-02', '04-16', '05-02', '05-16', '06-02', '06-16', '07-02', '07-16'];
    for (const r of reads) {
      const at = d(r);
      while (all.length && all[0].createdAt <= at) ledger.push(all.shift()!);
      const { start } = windowedReplay(ledger, at);
      if (start !== null) expect(start).toEqual(d('01-01'));
      settleAt(ledger, at);
    }
    const settled = Object.fromEntries(
      ledger.filter((e) => e.sourceType === 'grant-expiry').map((e) => [e.sourceId, e.amountMicroCents]),
    );
    for (let m = 1; m <= 6; m++) {
      expect(settled[`D${m}`]).toBe(-40n);
      expect(settled[`L${m}`]).toBe(-100n);
    }
  });

  it('P11 (L5): a settlement inside the window for a grant before it is passed over', () => {
    const entries = [
      grant('G', 100, d('01-01'), d('02-01')),
      debit(30, d('01-20')),
      debit(50, d('02-03')),
      grant('M', 100, d('02-05'), d('03-01')),
      debit(20, d('02-07')),
    ];
    expect(settleAt(entries, d('02-09')).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([['G', -70n]]);
    const { start, result } = windowedReplay(entries, d('02-10'));
    expect(start).toEqual(d('02-05'));
    expect(result!.expiring.map((e) => [e.grantId, e.remaining])).toEqual([['M', 80n]]);
    expect(result!.toSettle).toEqual([]);
    // The buckets still add up to the sum of the entries: 30.
    expect(result!.permanent + 80n).toBe(sum(entries));
    expect(settleAt(entries, d('03-01')).map((s) => [s.sourceId, s.amountMicroCents])).toEqual([['M', -80n]]);
    expect(sum(entries)).toBe(-50n);
  });

  it('P12 (decisions row p): a free grant pays while credit that never expires is below zero', () => {
    const entries = [debit(50, d('01-01')), grant('F', 100, d('01-02'), d('02-01')), debit(50, d('01-10'))];
    const mid = replayLedger(entries, d('01-15'));
    expect(mid.permanent).toBe(-50n);
    expect(mid.expiring.map((e) => [e.grantId, e.remaining])).toEqual([['F', 50n]]);
    settleAt(entries, d('02-01'));
    expect(sum(entries)).toBe(-50n);
  });

  it('entries after `now` are not part of the replay, and the expiring list is soonest first', () => {
    const entries = [
      grant('LATE', 100, d('01-01'), d('03-01')),
      grant('SOON', 100, d('01-02'), d('02-01')),
      debit(30, d('01-10')),
      debit(500, d('01-20')),
    ];
    const r = replayLedger(entries, d('01-15'));
    expect(r.expiring.map((e) => [e.grantId, e.remaining, e.expiresAt])).toEqual([
      ['SOON', 70n, d('02-01')],
      ['LATE', 100n, d('03-01')],
    ]);
  });
});

/** mulberry32: a small seeded PRNG, so a failing ledger can be reproduced from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('#5011 P13 property: settling through the window equals a full replay', () => {
  it('20,000 random ledgers', () => {
    const DAY = 86_400_000;
    const base = d('01-01').getTime();
    const LEDGERS = 20_000;
    for (let n = 0; n < LEDGERS; n++) {
      const seed = 0x5011_0000 + n;
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
      const generated: ReplayEntry[] = [];
      const expiries: number[] = [];
      const count = 2 + Math.floor(rnd() * 8);
      let id = 0;
      const mkId = (p: string) => `${p}${String(++id).padStart(4, '0')}`;
      for (let i = 0; i < count; i++) {
        const kind = rnd();
        let at = base + Math.floor(rnd() * 60) * DAY;
        if (kind < 0.35) {
          const exp = at + pick([5, 10, 20, 30]) * DAY;
          expiries.push(exp);
          generated.push(grant(mkId('g'), pick([50, 100, 200]), new Date(at), new Date(exp)));
        } else if (kind < 0.5) {
          generated.push(grant(mkId('p'), pick([50, 100, 200]), new Date(at)));
        } else if (kind < 0.9) {
          // Some debits land exactly on an expiry instant.
          if (expiries.length && rnd() < 0.3) at = pick(expiries);
          generated.push(debit(pick([10, 40, 90, 150]), new Date(at), mkId('d')));
        } else {
          generated.push(adjustment(pick([-60, -20, 20, 60]), new Date(at), pick(['refund', 'credit']), mkId('x'), mkId('a')));
        }
      }
      generated.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const readCount = 1 + Math.floor(rnd() * 6);
      const reads = Array.from({ length: readCount }, () => base + Math.floor(rnd() * 100) * DAY + (rnd() < 0.3 ? 0 : 3_600_000));
      if (expiries.length && rnd() < 0.5) reads.push(pick(expiries));
      reads.push(base + 200 * DAY);
      reads.sort((a, b) => a - b);

      const ledger: ReplayEntry[] = [];
      const pending = [...generated];
      const fail = (what: string) => {
        throw new Error(`seed ${seed} ledger ${n}: ${what}\n${JSON.stringify(generated, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      };
      for (const t of reads) {
        const at = new Date(t);
        while (pending.length && pending[0].createdAt <= at) ledger.push(pending.shift()!);
        const windowed = windowedReplay(ledger, at).result;
        const full = replayLedger(ledger, at);
        const w = (windowed?.expiring ?? []).map((e) => `${e.grantId}:${e.remaining}`).join(',');
        const f = full.expiring.map((e) => `${e.grantId}:${e.remaining}`).join(',');
        if (w !== f) fail(`expiring at ${at.toISOString()}: windowed ${w} vs full ${f}`);
        settleAt(ledger, at);
      }
      // The oracle: each grant's remainder at its expiry, from a full replay of the generated entries alone.
      const oracle = settleMap(replayLedger(generated, new Date(base + 400 * DAY)));
      const written = ledger.filter((e) => e.sourceType === 'grant-expiry');
      if (written.length !== Object.keys(oracle).length) fail(`${written.length} settlements, oracle ${Object.keys(oracle).length}`);
      for (const s of written) {
        if (s.amountMicroCents !== -oracle[s.sourceId as string]) {
          fail(`grant ${s.sourceId} settled ${s.amountMicroCents}, oracle ${-oracle[s.sourceId as string]}`);
        }
      }
    }
  });
});

describe('#5011 replayWindowStart', () => {
  it('opens at the oldest unsettled expiring grant and moves back while a grant was live at the start', () => {
    const grants = [
      { id: 'A', createdAt: d('01-01'), expiresAt: d('02-01') },
      { id: 'B', createdAt: d('01-20'), expiresAt: d('03-01') },
      { id: 'C', createdAt: d('02-20'), expiresAt: d('04-01') },
    ];
    // C unsettled; B (settled) live at 20 Feb; A (settled) live at 20 Jan: two moves.
    expect(replayWindowStart(grants, new Set(['A', 'B']))).toEqual(d('01-01'));
    // A grant that expired before the start does not move it.
    expect(replayWindowStart([{ id: 'X', createdAt: d('01-01'), expiresAt: d('01-10') }, grants[2]], new Set(['X']))).toEqual(
      d('02-20'),
    );
    expect(replayWindowStart(grants, new Set(['A', 'B', 'C']))).toBeNull();
  });
});
