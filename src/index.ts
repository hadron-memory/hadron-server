import './instrument.js'; // Sentry — must be imported before any other module
import 'dotenv/config';
import './lib/automation/config.js';
import { createServer } from './server.js';
import { controller } from './controller/controller.js';

const port = Number(process.env.PORT ?? 4000);

const app = await createServer();

const httpServer = app.listen(port, () => {
  console.log(`hadron-server listening on http://localhost:${port}`);
  console.log(`GraphQL: http://localhost:${port}/graphql`);
  console.log(`MCP:     http://localhost:${port}/mcp`);

  // Sync graphs in the background (non-blocking)
  controller.startup().catch((err) => {
    console.error('Startup graph sync failed:', err);
  });
});

// internal#4: close admission before graceful process exit. This is a lifecycle hook,
// not a deployment/fencing action; rollout still requires the operator's cohort boundary.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const requestsDrained = new Promise<boolean>(resolve => {
    httpServer.close(error => resolve(!error));
  });
  const deadline = setTimeout(() => process.exit(1), 10_000);
  void Promise.all([requestsDrained, app.locals.stopEmbeddingWorker?.()]).then(
    results => { clearTimeout(deadline); process.exit(results.every(Boolean) ? 0 : 1); },
    () => { clearTimeout(deadline); process.exit(1); },
  );
});
