/** Bounded batches; the server supplies the real shared-store cleanup. */
export function startRateBucketCleanupLoop(clean: () => Promise<{ count: number }>, onError: (error: unknown) => void) {
  const timer = setInterval(() => {
    void (async () => {
      for (let pass = 0; pass < 20; pass++) if ((await clean()).count < 200) break;
    })().catch(onError);
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
