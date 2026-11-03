/** Bounded batches; the server supplies the real shared-store cleanup. */
export function startRateBucketCleanupLoop(clean: () => Promise<{ count: number }>, onError: (error: unknown) => void) {
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>;
  const schedule=(delay:number)=>{
    if(stopped)return;
    timer=setTimeout(()=>{void run();},delay);
    timer.unref();
  };
  const run=async()=>{
    let delay=60_000;
    try {
      // Keep draining a backlog, yielding between bounded transactions. There
      // is no fixed 4,000-row/minute ceiling and no overlapping local pass.
      if((await clean()).count===200)delay=100;
    } catch(error){onError(error);}
    finally {schedule(delay);}
  };
  schedule(60_000);
  return ()=>{stopped=true;clearTimeout(timer);};
}
