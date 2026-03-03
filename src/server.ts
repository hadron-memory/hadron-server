import crypto from 'crypto';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import cors from 'cors';
import express from 'express';
import { db } from './db/client.js';
import { serializeJson } from './db/provider.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUser,
  checkOrgMembership,
  signJwt,
  verifyJwt,
} from './auth/index.js';
import { resolveAuthContext } from './middleware/auth.js';
import { resolvers } from './api/graphql/schema/resolvers.js';
import { typeDefs } from './api/graphql/schema/typeDefs.js';
import {controller} from "./controller/controller";

export async function createServer() {
  const app = express();

  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      credentials: true,
    }),
  );
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // GitHub OAuth
  // ---------------------------------------------------------------------------

  // Pending OAuth states (in-memory; sufficient for single-instance deployment)
  const pendingStates = new Map<
    string,
    { redirect: string; expiresAt: number }
  >();

  // Step 1: redirect to GitHub
  app.get('/auth/github', (req, res) => {
    const redirect = (req.query.redirect as string) || '/';
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
      redirect,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.redirect(buildAuthUrl(state));
  });

  // Step 2: GitHub callback — exchange code, upsert user, issue JWT
  app.get('/auth/github/callback', async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state' });
      return;
    }

    const pending = pendingStates.get(state);
    pendingStates.delete(state);

    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired state' });
      return;
    }

    try {
      const ghToken = await exchangeCode(code);
      const ghUser = await fetchUser(ghToken);

      // Optional org membership check
      const requiredOrg = process.env.GITHUB_ORG;
      if (requiredOrg) {
        const isMember = await checkOrgMembership(ghToken, requiredOrg);
        if (!isMember) {
          res.status(403).json({
            error: `Must be a member of the ${requiredOrg} GitHub organization`,
          });
          return;
        }
      }

      // Upsert user
      const user = await db.user.upsert({
        where: { githubId: ghUser.id },
        create: {
          githubId: ghUser.id,
          login: ghUser.login,
          name: ghUser.name,
          avatarUrl: ghUser.avatar_url,
          role: 'READER',
        },
        update: {
          login: ghUser.login,
          name: ghUser.name,
          avatarUrl: ghUser.avatar_url,
        },
      });

      // Issue JWT
      const jwt = await signJwt({
        sub: user.id,
        login: user.login,
        role: user.role as 'ADMIN' | 'CONTRIBUTOR' | 'READER',
        githubId: ghUser.id,
      });

      // Redirect to frontend with token
      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const redirectUrl = new URL(pending.redirect, frontendUrl);
      redirectUrl.searchParams.set('token', jwt);
      res.redirect(redirectUrl.toString());
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).json({ error: 'OAuth authentication failed' });
    }
  });

  // Current user info from JWT
  app.get('/auth/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    try {
      const payload = await verifyJwt(authHeader.slice(7));
      const user = await db.user.findUnique({ where: { id: payload.sub } });
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({
        id: user.id,
        githubId: user.githubId,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
      });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });

  // ---------------------------------------------------------------------------
  // GraphQL
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  // Ingest usage events (lightweight, no GraphQL overhead for high-frequency calls)
  app.post('/usage', async (req, res) => {
    const event = req.body;
    await controller.operations.createUsageEvent(event);
    // if (!event?.type) {
    //   res.status(400).json({ error: 'Missing event.type' });
    //   return;
    // }
    // try {
    //   const node = event.nodeLoc
    //     ? await db.node.findUnique({ where: { loc: event.nodeLoc } })
    //     : null;
    //   await db.usageEvent.create({
    //     data: {
    //       type: event.type,
    //       nodeLoc: event.nodeLoc,
    //       nodeId: node?.id,
    //       actionArgs: serializeJson(event.actionArgs) as typeof event.actionArgs,
    //       clientId: event.clientId,
    //       sessionId: event.sessionId,
    //     },
    //   });
    //   res.json({ ok: true });
    // } catch (err) {
    //   console.error('Usage ingest error:', err);
    //   res.status(500).json({ error: 'Internal error' });
    // }
  });

  // Report session outcome — callable by any system (CRM webhook, edge device, AI agent)
  app.post('/sessions/:id/outcome', async (req, res) => {
    const { id } = req.params;
    const { outcome, outcomeRef, outcomeMeta } = req.body ?? {};
    if (typeof outcome !== 'number' || outcome < 0 || outcome > 1) {
      res
        .status(400)
        .json({ error: 'outcome must be a number between 0 and 1' });
      return;
    }
    try {
      await db.session.update({
        where: { id },
        data: {
          outcome,
          outcomeRef,
          outcomeMeta: serializeJson(outcomeMeta) as typeof outcomeMeta,
        },
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Outcome report error:', err);
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Trigger a graph reload (called by collection tool after pushing nodes)
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
