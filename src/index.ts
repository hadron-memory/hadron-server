import './instrument.js'; // Sentry — must be imported before any other module
import 'dotenv/config';
import { createServer } from './server.js';
import { controller } from './controller/controller.js';

const port = Number(process.env.PORT ?? 4000);

const app = await createServer();

app.listen(port, () => {
  console.log(`hadron-server listening on http://localhost:${port}`);
  console.log(`GraphQL: http://localhost:${port}/graphql`);
  console.log(`MCP:     http://localhost:${port}/mcp`);

  // Sync graphs in the background (non-blocking)
  controller.startup().catch((err) => {
    console.error('Startup graph sync failed:', err);
  });
});
