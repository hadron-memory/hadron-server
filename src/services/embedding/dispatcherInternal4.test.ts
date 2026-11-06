import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingDispatcher } from './dispatcher.js';

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const dispatchers: EmbeddingDispatcher[] = [];
const make = (select = vi.fn(async (_limit: number): Promise<string[]> => []), run = vi.fn(async (_id: string) => {})) => {
  const d = new EmbeddingDispatcher({ select, run, onError: vi.fn() });
  dispatchers.push(d);
  return { d, select, run };
};

afterEach(async () => {
  for (const d of dispatchers.splice(0)) await d.stop(0);
});

describe('internal#4 shared embedding dispatcher', () => {
  it('admits before work: two held pipelines, no queued closures or third DB/endpoint call', async () => {
    const held = barrier();
    let active = 0;
    let peak = 0;
    const work = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await held.promise;
      active--;
    });
    const { d } = make();
    expect(d.tryRun('a', work)).toBe(true);
    expect(d.tryRun('b', work)).toBe(true);
    const rejected = vi.fn(async () => {});
    expect(d.tryRun('c', rejected)).toBe(false);
    await turn();
    expect(work).toHaveBeenCalledTimes(2);
    expect(rejected).not.toHaveBeenCalled();
    expect(d.state()).toMatchObject({ active: 2, queued: 0, selecting: false });
    held.release();
    await turn();
    expect(peak).toBe(2);
    expect(rejected).not.toHaveBeenCalled(); // capacity release never resurrects a rejected plaintext closure
  });

  it('a duplicate active node coalesces without starting a second pipeline', async () => {
    const held = barrier();
    const { d } = make();
    const duplicate = vi.fn(async () => {});
    expect(d.tryRun('a', () => held.promise)).toBe(true);
    expect(d.tryRun('a', duplicate)).toBe(false);
    await turn();
    expect(d.state().active).toBe(1);
    expect(duplicate).not.toHaveBeenCalled();
    held.release();
    await turn();
  });

  it('bus/sweep/prompt nudges share a single held selector and at most 25 candidate ids', async () => {
    const selecting = barrier();
    const running = barrier();
    const select = vi.fn(async (limit: number) => {
      expect(limit).toBe(25);
      await selecting.promise;
      return ['a', 'b', 'c'];
    });
    const { d, run } = make(select, vi.fn(async () => running.promise));
    d.nudge(); d.nudge(); d.nudge();
    await turn();
    expect(select).toHaveBeenCalledTimes(1);
    d.nudge(); d.nudge();
    await turn();
    expect(select).toHaveBeenCalledTimes(1);
    selecting.release();
    await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(d.state()).toMatchObject({ active: 2, queued: 0, selecting: true });
    // The third candidate is an ID only: no waiting job closure or plaintext payload.
    expect(run.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    await d.stop(0);
    running.release();
    await turn();
  });

  it('slot release rechecks durable work rather than retaining overflow jobs', async () => {
    const held = barrier();
    const select = vi.fn(async () => select.mock.calls.length === 1 ? ['durable'] : []);
    const { d, run } = make(select);
    d.tryRun('a', () => held.promise);
    d.tryRun('b', () => held.promise);
    d.nudge();
    await turn();
    expect(select).not.toHaveBeenCalled();
    held.release();
    await turn(); await turn(); await turn();
    expect(run).toHaveBeenCalledWith('durable');
    expect(d.state().queued).toBe(0);
  });

  it('ordinary durable work takes the next released slot ahead of a sustained encrypted prompt stream', async () => {
    const first = barrier();
    const second = barrier();
    const replacement = barrier();
    const ordinary = vi.fn(async (_id: string) => {});
    const select = vi.fn(async () => select.mock.calls.length === 1 ? ['ordinary-due'] : []);
    const { d } = make(select, ordinary);
    // These closures model authorized encrypted prompts: the keyless selector cannot
    // recover them, and their synthetic endpoint holds both shared pipeline slots.
    expect(d.tryRun('encrypted-a', () => first.promise)).toBe(true);
    expect(d.tryRun('encrypted-b', () => second.promise)).toBe(true);
    d.nudge(); // an ordinary committed obligation is ready in the durable source
    await turn();
    expect(select).not.toHaveBeenCalled();
    try {
      first.release();
      // Complete the endpoint promise chain without yielding to setImmediate. This
      // deliberately gives fresh request callbacks the most hostile ordering.
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
      expect(d.state().active).toBe(1);
      const admitted = Array.from({ length: 1000 }, (_, i) =>
        d.tryRun(`encrypted-replacement-${i}`, () => replacement.promise));
      await turn(); await turn();
      // Progress within ONE release, while the other encrypted endpoint stays held.
      expect(ordinary).toHaveBeenCalledWith('ordinary-due');
      expect(admitted.some(Boolean)).toBe(false);
      expect(d.state()).toMatchObject({ active: 1, queued: 0 });
    } finally {
      await d.stop(0);
      first.release(); second.release(); replacement.release();
      await turn();
    }
  });

  it('an asynchronous durable selection keeps priority before its candidate ids arrive', async () => {
    const selecting = barrier();
    const select = vi.fn(async () => { await selecting.promise; return ['ordinary-due']; });
    const { d, run } = make(select);
    const batch = d.drainWith(run);
    try {
      expect(d.state().selecting).toBe(true);
      const prompt = vi.fn(async () => {});
      expect(d.tryRun('encrypted-new', prompt)).toBe(false);
      expect(prompt).not.toHaveBeenCalled();
      selecting.release();
      await batch;
      expect(run).toHaveBeenCalledWith('ordinary-due');
    } finally { selecting.release(); await batch; }
  });

  it('oversized caller and adapter batches cannot admit more than 25 candidate ids', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `candidate-${i}`);
    const select = vi.fn(async (_limit: number) => ids);
    const { d, run } = make(select);
    await d.drainWith(run, 100);
    expect(select).toHaveBeenCalledWith(25);
    expect(run.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 25));
  });

  it('empty selection is quiescent, not a polling promise loop', async () => {
    const { d, select } = make();
    d.nudge();
    await turn(); await turn(); await turn();
    expect(select).toHaveBeenCalledTimes(1);
    expect(d.state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false });
  });

  it('errors release slots and are reported without an unhandled rejection', async () => {
    const error = new Error('synthetic');
    const onError = vi.fn();
    const d = new EmbeddingDispatcher({ select: async () => [], run: async () => {}, onError });
    dispatchers.push(d);
    expect(d.tryRun('a', async () => { throw error; })).toBe(true);
    await turn();
    expect(onError).toHaveBeenCalledWith(error);
    expect(d.state().active).toBe(0);
  });

  it('stop closes admission and cancels a scheduled selector without executing it', async () => {
    const { d, select } = make();
    d.nudge();
    await d.stop(0);
    const work = vi.fn(async () => {});
    expect(d.tryRun('after-stop', work)).toBe(false);
    d.nudge();
    await turn();
    expect(select).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('shutdown timeout does not pretend an un-aborted job released its slot', async () => {
    const held = barrier();
    const { d } = make();
    d.tryRun('a', () => held.promise);
    await turn();
    expect(await d.stop(0)).toBe(false);
    expect(d.state().active).toBe(1);
    expect(d.tryRun('b', async () => {})).toBe(false);
    held.release();
    await turn();
    expect(d.state().active).toBe(0);
    expect(await d.stop(0)).toBe(true);
  });
});
