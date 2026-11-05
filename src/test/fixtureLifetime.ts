/** Opt-in test fixture boundary. A Vitest deadline does not cancel the body. */
export class FixtureLifetime {
  private readonly pending = new Set<Promise<unknown>>();
  private draining: Promise<void> | undefined;

  run<T>(body: () => Promise<T>): Promise<T> {
    if (this.draining) throw new Error('Cannot start a fixture body during cleanup');
    const work = Promise.resolve().then(body);
    this.pending.add(work);
    // Return the original promise to the runner, preserving its failure.
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  drain(closeResources: () => Promise<void>): Promise<void> {
    // A hook can itself hit its deadline. beforeEach must join that SAME
    // cleanup before resetting anything, rather than begin a new fixture.
    if (!this.draining) {
      this.draining = (async () => {
        // Interrupt network waits before awaiting the body.
        await closeResources();
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        // A tail may have created a client/server after the first close.
        await closeResources();
      })().finally(() => { this.draining = undefined; });
    }
    return this.draining;
  }
}
