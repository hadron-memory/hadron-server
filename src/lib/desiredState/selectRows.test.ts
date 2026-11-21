/**
 * #4260 — unit pins of `selectRows` (no database): the selector's match precedence and its
 * total multi-row semantics. The one-row-per-name guarantee that makes the name form single-row
 * in a provisioned database is `workers_app_name_uniq`, pinned where the read runs, in
 * resolvers.desiredWorker4260.test.ts; these pins cover the pure function itself, including the
 * same-named rows a provisioned database cannot hold.
 */
import { describe, expect, it } from 'vitest';
import { selectRows } from './selectRows.js';

const row = (workerId: string, name: string) => ({ workerId, name });
const rows = [row('w-ada', 'Ada'), row('w-kit', 'Kit'), row('w-zoe', 'Zoe')];

describe('#4260 selectRows', () => {
  it('no selector, or an empty one, is the host-wide list unchanged', () => {
    expect(selectRows(rows, undefined)).toBe(rows);
    expect(selectRows(rows, '')).toBe(rows);
  });

  it('an exact id match selects that one row — the exactly-one form, winning over a name match', () => {
    // w-ada is also a name another row could carry; the id reading wins.
    const collides = [...rows, row('w-echo', 'w-ada')];
    expect(selectRows(collides, 'w-ada')).toEqual([row('w-ada', 'Ada')]);
    expect(selectRows(rows, 'w-kit')).toEqual([row('w-kit', 'Kit')]);
  });

  it('an exact name match selects the same-named row', () => {
    expect(selectRows(rows, 'Ada')).toEqual([row('w-ada', 'Ada')]);
  });

  it('a name match is EVERY same-named row in host order, never a silent first match', () => {
    // A provisioned database cannot hold these rows (workers_app_name_uniq); the function stays
    // total for one that ever did.
    const dup = [row('w-1', 'Kit'), row('w-2', 'Ada'), row('w-3', 'Kit')];
    expect(selectRows(dup, 'Kit')).toEqual([row('w-1', 'Kit'), row('w-3', 'Kit')]);
  });

  it('a selector that matches nothing returns the same empty list as an unknown worker', () => {
    expect(selectRows(rows, 'Nobody')).toEqual([]);
    expect(selectRows(rows, 'w-nobody')).toEqual([]);
    // Exact-case: the name match does not fold case.
    expect(selectRows(rows, 'KIT')).toEqual([]);
  });
});
