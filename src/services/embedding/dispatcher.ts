/** Internal#4: one admission point for prompt, sweep and bus embedding work.
 * No waiting closures: a rejected prompt's plaintext is never retained here. Postgres owns
 * overflow work. These bounds are process-local, not a tenant quota or a fleet-wide lease.
 */
export class EmbeddingDispatcher {
  private readonly active = new Set<string>();
  private selecting = false;
  private dirty = false;
  private closed = false;
  private scheduled: NodeJS.Immediate | undefined;
  private readonly idleListeners = new Set<() => void>();
  private readonly capacityListeners = new Set<() => void>();

  constructor(private readonly options: {
    select: (limit: number) => Promise<string[]>;
    run: (id: string) => Promise<unknown>;
    onError: (error: unknown) => void;
  }) {}

  /** Slot acquired synchronously BEFORE the closure can do any DB or endpoint work. */
  tryRun(id: string, work: () => Promise<unknown>): boolean {
    // A requested/active durable drain owns the next available slots, including
    // the gap before its setImmediate and while its selector is awaiting I/O.
    // Otherwise fresh encrypted prompts can repeatedly steal every released slot.
    // Rejection retains no closure/plaintext; encrypted overflow stays pending (R132).
    if (this.dirty || this.scheduled || this.selecting) return false;
    return this.admit(id, work);
  }

  private admit(id: string, work: () => Promise<unknown>, settled?: () => void, resume = true): boolean {
    if (this.closed || this.active.size >= 2 || this.active.has(id)) return false;
    this.active.add(id);
    void Promise.resolve().then(work).catch((error) => this.report(error)).finally(() => {
      this.active.delete(id);
      settled?.();
      for (const listener of this.capacityListeners) listener();
      if (!this.closed && resume) this.nudge();
      this.signalIdle();
    });
    return true;
  }

  /** Constant-space wake; no node id or plaintext is stored while capacity is full. */
  nudge(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.selecting || this.scheduled || !this.dirty || this.active.size >= 2) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      void this.select();
    });
  }

  private async select(): Promise<void> {
    const outcomes = await this.drainWith(this.options.run);
    if (outcomes.length) this.nudge();
  }

  /** Manual/test batch uses the SAME control/pipeline admission, never a parallel drain. */
  async drainWith(run: (id: string) => Promise<unknown>, batchSize = 25): Promise<unknown[]> {
    if (this.closed || this.selecting || this.active.size >= 2) return [];
    this.selecting = true;
    this.dirty = false;
    const outcomes: unknown[] = [];
    const running = new Set<Promise<void>>(); // <=2 admitted jobs, never waiting jobs
    try {
      // The adapter must enforce LIMIT 25 in SQL; slicing also refuses a buggy adapter's
      // oversized dispatch. Undispatched rows stay in the durable source, never in a queue.
      const limit = Number.isFinite(batchSize) ? Math.max(1, Math.min(25, Math.trunc(batchSize))) : 25;
      const ids = (await this.options.select(limit)).slice(0, limit);
      // Keep the one control reservation while consuming this bounded ID-only batch.
      // Advancing a fair-selector cursor past candidates that were never admitted can
      // starve memories. No per-id callback/plaintext is created before a slot is free.
      for (const id of ids) {
        while (!this.closed && this.active.size >= 2) {
          await new Promise<void>(resolve => {
            const available = () => { this.capacityListeners.delete(available); resolve(); };
            this.capacityListeners.add(available);
          });
        }
        if (this.closed) break;
        let done!: () => void;
        const settled = new Promise<void>((resolve) => { done = resolve; });
        if (this.admit(id, async () => { outcomes.push(await run(id)); }, () => {
          running.delete(settled);
          done();
        }, false)) running.add(settled);
      }
      // Keep this sole control reservation until its admitted jobs retire too;
      // otherwise another selector could retain a second 25-ID batch while a
      // slow final pipeline still holds this async activation alive.
      await Promise.all(running);
    } catch (error) {
      this.report(error);
      // No tight retry loop on a failing selector: the next external wake/sweep retries it.
      this.dirty = false;
    } finally {
      this.selecting = false;
      this.schedule();
      this.signalIdle();
    }
    return outcomes;
  }

  private report(error: unknown): void {
    try { this.options.onError(error); } catch { /* logging cannot strand a slot */ }
  }

  private signalIdle(): void {
    if (this.active.size || this.selecting) return;
    for (const listener of this.idleListeners) listener();
  }

  /** False means grace elapsed while real work still runs; never manufacture released capacity. */
  async stop(graceMs = 5_000): Promise<boolean> {
    this.closed = true;
    this.dirty = false;
    for (const listener of this.capacityListeners) listener();
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    if (!this.active.size && !this.selecting) return true;
    if (graceMs <= 0) return false;
    return new Promise<boolean>((resolve) => {
      const finish = (settled: boolean) => {
        clearTimeout(timer);
        this.idleListeners.delete(idle);
        resolve(settled);
      };
      const idle = () => finish(true);
      const timer = setTimeout(() => finish(false), graceMs);
      this.idleListeners.add(idle);
    });
  }

  /** Counts only; never exposes retained plaintext, ids, keys or callbacks. */
  state() {
    return {
      active: this.active.size, selecting: this.selecting, scheduled: !!this.scheduled,
      dirty: this.dirty, closed: this.closed, queued: 0,
    };
  }
}
