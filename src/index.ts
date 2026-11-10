import './instrument.js'; // Sentry — must be imported before any other module
import 'dotenv/config';
import './lib/automation/config.js';
import { createServer } from './server.js';
import { controller } from './controller/controller.js';
import { db } from './integrations/db/client.js';
import { createReadiness } from './api/health.js';
import { stoppingDrainWindowMs } from './lib/stoppingDrainWindow.js';
import { closeHttpListenerOutcome } from './lib/httpShutdown.js';
import { errorToken, logFailedShutdownSteps, type EmbeddingStopOutcomes, type StepOutcome } from './lib/shutdownSteps.js';

const port = Number(process.env.PORT ?? 4000);

// #2998 (cor:api:270:01): what GET /ready reads. Only the first startup
// attempt below is tracked; a later POST /reload never changes readiness.
const readiness = createReadiness();

const app = await createServer({ readiness });

const httpServer = app.listen(port, () => {
  console.log(`hadron-server listening on http://localhost:${port}`);
  console.log(`GraphQL: http://localhost:${port}/graphql`);
  console.log(`MCP:     http://localhost:${port}/mcp`);

  // Sync graphs in the background (non-blocking)
  readiness.trackFirstStartup(controller.startup(), (err) => {
    console.error('Startup graph sync failed:', err);
  });
});

// internal#4: close admission before graceful process exit. This is a lifecycle hook,
// not a deployment/fencing action; rollout still requires the operator's cohort boundary.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // #2998: probes still served while draining answer /ready 503 stopping.
  readiness.markStopping();
  // #3021: keep accepting connections for a bounded window so a proxy polling
  // /ready sees 503 stopping before the listener closes. The hard deadline is
  // the window plus the original 10 s, so a long window never eats the drain.
  const windowMs = stoppingDrainWindowMs();
  const deadline = setTimeout(() => process.exit(1), windowMs + 10_000);
  const requestsDrained = new Promise<StepOutcome>(resolve => {
    const closeListener = () => void closeHttpListenerOutcome(httpServer).then(resolve);
    // 0 closes synchronously, exactly as before the window existed.
    if (windowMs > 0) setTimeout(closeListener, windowMs); else closeListener();
  });
  // #446: disconnect only after HTTP and the worker have settled; keep the
  // same deadline active through disconnect, and preserve the drain exit code.
  void Promise.allSettled([requestsDrained, app.locals.stopEmbeddingWorker?.()]).then(async results => {
    // #3845: when the drain decides 1, say which step failed. The code itself is decided exactly as before.
    const [listener, embedding] = results as [PromiseSettledResult<StepOutcome>, PromiseSettledResult<EmbeddingStopOutcomes | undefined>];
    const rejected = (r: PromiseRejectedResult): StepOutcome => `rejected:${errorToken(r.reason)}`;
    const steps: Array<[string, StepOutcome]> = [['http_listener', listener.status === 'fulfilled' ? listener.value : rejected(listener)]];
    // (A missing hook folded to exit 1 before, since `undefined` is not truthy; the code stays, now with a name.)
    if (embedding.status === 'fulfilled' && embedding.value === undefined) steps.push(['embedding_worker', 'not_registered']);
    else if (embedding.status === 'fulfilled') steps.push(['embedding_worker', embedding.value?.worker ?? 'unreported'], ['embedding_publisher', embedding.value?.publisher ?? 'unreported']);
    else steps.push(['embedding_worker', rejected(embedding)]);
    const exitCode = logFailedShutdownSteps(steps) === 0 ? 0 : 1;
    try {
      await db.$disconnect();
    } catch {
      console.error('Prisma disconnect failed during shutdown.');
    }
    clearTimeout(deadline);
    process.exit(exitCode);
  });
});
