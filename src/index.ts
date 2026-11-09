import './instrument.js'; // Sentry — must be imported before any other module
import 'dotenv/config';
import './lib/automation/config.js';
import { createServer } from './server.js';
import { controller } from './controller/controller.js';
import { db } from './integrations/db/client.js';
import { createReadiness } from './api/health.js';
import { stoppingDrainWindowMs } from './lib/stoppingDrainWindow.js';

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
  const requestsDrained = new Promise<boolean>(resolve => {
    const closeListener = () => httpServer.close(error => resolve(!error));
    // 0 closes synchronously, exactly as before the window existed.
    if (windowMs > 0) setTimeout(closeListener, windowMs); else closeListener();
  });
  // #446: disconnect only after HTTP and the worker have settled; keep the
  // same deadline active through disconnect, and preserve the drain exit code.
  void Promise.allSettled([requestsDrained, app.locals.stopEmbeddingWorker?.()]).then(async results => {
    const exitCode = results.every(result => result.status === 'fulfilled' && result.value) ? 0 : 1;
    try {
      await db.$disconnect();
    } catch {
      console.error('Prisma disconnect failed during shutdown.');
    }
    clearTimeout(deadline);
    process.exit(exitCode);
  });
});
