import { describe, it, expect } from 'vitest';
import { LIST_PAGE_DEFAULT, LIST_PAGE_MAX, clampListTake } from './resolvers.helpers.js';
import { clampGraphTake, GRAPH_PAGE_DEFAULT } from './resolvers.query.memory.js';
import { STOP_SIGNAL_PAGE_DEFAULT } from './resolvers.stopSignal.js';
import { DUE_WAKES_PAGE_DEFAULT } from '../../../lib/tickers/dueWakes.js';
import { DELIVERY_BATCHES_PAGE_DEFAULT } from '../../../lib/tickers/deliveryBatch.js';
import { PAGE_RESULT_PAIRS_DEFAULT } from '../../../lib/teamAttentionPage.js';
import { GLOBAL_SEARCH_DEFAULT_LIMIT } from '../../../lib/global-search/index.js';

// #2211 — every surface that already pages answers an omitted size with 20.
describe('#2211 default page size is 20', () => {
  it('shared constants', () => {
    for (const d of [
      LIST_PAGE_DEFAULT,
      GRAPH_PAGE_DEFAULT,
      STOP_SIGNAL_PAGE_DEFAULT,
      DUE_WAKES_PAGE_DEFAULT,
      DELIVERY_BATCHES_PAGE_DEFAULT,
      PAGE_RESULT_PAIRS_DEFAULT,
      GLOBAL_SEARCH_DEFAULT_LIMIT,
    ]) {
      expect(d).toBe(20);
    }
  });

  it('clampListTake: omitted and null give 20, 0 stays count-only, the cap is unchanged', () => {
    expect(clampListTake()).toBe(20);
    expect(clampListTake(null)).toBe(20);
    expect(clampListTake(0)).toBe(0);
    expect(clampListTake(-3)).toBe(0);
    expect(clampListTake(21)).toBe(21);
    expect(clampListTake(100000)).toBe(LIST_PAGE_MAX);
  });

  it('clampGraphTake: omitted and null give 20, 0 stays count-only, the cap is unchanged', () => {
    expect(clampGraphTake()).toBe(20);
    expect(clampGraphTake(null)).toBe(20);
    expect(clampGraphTake(0)).toBe(0);
    expect(clampGraphTake(2000)).toBe(2000);
    expect(clampGraphTake(5000)).toBe(2000);
  });
});
