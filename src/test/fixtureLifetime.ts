/** Tracks opt-in test bodies separately from Vitest's deadline promise. */
export class FixtureLifetime {
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(body: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(body);
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  async drain(closeResources: () => Promise<void>): Promise<void> {
    // Baseline: close network resources, as the existing fixture did.
    await closeResources();
  }
}
