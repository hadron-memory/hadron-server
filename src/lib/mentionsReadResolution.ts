/**
 * #2018 (S2): which worker a channel read's mentions filter resolved to, keyed by the page object the read returned.
 * The read (`readChannelRoot`) records it; the own-read advance (`maybeAdvanceOwnChannelRead`) reads it, so the marks
 * move only for the exact principal whose reach the page was filtered by, never for a re-resolution that could
 * disagree with it (a same-named worker of another App, a user handle). A page with no record moves nothing.
 */
const resolved = new WeakMap<object, string>();

/** Record that `page` holds exactly the messages that reach `workerId` (`reachesWorker`). */
export function recordMentionsWorker(page: object, workerId: string): void {
  resolved.set(page, workerId);
}

/** The worker `page`'s mentions filter resolved to, or null (no filter, a user filter, or nothing resolved). */
export function mentionsWorkerOf(page: object): string | null {
  return resolved.get(page) ?? null;
}
