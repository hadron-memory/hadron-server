import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import express from 'express';
import { db } from './db/client.js';
import { resolveAuthContext } from './middleware/auth.js';
import { resolvers } from './schema/resolvers.js';
import { typeDefs } from './schema/typeDefs.js';

export async function createServer() {
  const app = express();
  app.use(express.json());

  const apollo = new ApolloServer({ typeDefs, resolvers });
  await apollo.start();

  app.use(
    '/graphql',
    expressMiddleware(apollo, {
      context: async ({ req }) => {
        const auth = await resolveAuthContext(req, db);
        return { db, ...auth };
      },
    }),
  );

  // REST: ingest usage events (lightweight, no GraphQL overhead for high-frequency calls)
  app.post('/usage', async (req, res) => {
    const event = req.body;
    if (!event?.type) {
      res.status(400).json({ error: 'Missing event.type' });
      return;
    }
    try {
      const node = event.nodeLoc ? await db.node.findUnique({ where: { loc: event.nodeLoc } }) : null;
      await db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: event.actionArgs,
          success: event.success,
          clientId: event.clientId,
          sessionId: event.sessionId,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Usage ingest error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // REST: trigger a graph reload (called by collection tool after pushing nodes)
  app.post('/reload', (_req, res) => {
    // Placeholder — in production, invalidate any in-memory graph cache here
    res.json({ ok: true });
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
