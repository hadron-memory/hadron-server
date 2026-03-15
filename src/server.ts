import crypto from 'crypto';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import cors from 'cors';
import express from 'express';
import { db } from './integrations/db/client.js';
import { serializeJson } from './integrations/db/provider.js';
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
import { controller } from './controller/controller.js';
import { handleMcpRequest, handleMcpDelete } from './mcp/server.js';

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

  const pendingStates = new Map<
    string,
    { redirect: string; expiresAt: number }
  >();

  app.get('/auth/github', (req, res) => {
    const redirect = (req.query.redirect as string) || '/';
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, {
      redirect,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    res.redirect(buildAuthUrl(state));
  });

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

      // Upsert user — first check by githubUsername to handle seed data
      // that may have a placeholder githubId
      const existing = await db.user.findUnique({
        where: { githubUsername: ghUser.login },
      });
      const user = existing
        ? await db.user.update({
            where: { id: existing.id },
            data: {
              githubId: ghUser.id,
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
            },
          })
        : await db.user.upsert({
            where: { githubId: ghUser.id },
            create: {
              githubId: ghUser.id,
              githubUsername: ghUser.login,
              identityProvider: 'GITHUB',
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
              roles: ['READER'],
            },
            update: {
              githubUsername: ghUser.login,
              name: ghUser.name,
              avatarUrl: ghUser.avatar_url,
            },
          });

      // Issue JWT
      const jwt = await signJwt({
        sub: user.id,
        githubUsername: user.githubUsername,
        roles: user.roles as ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[],
        githubId: ghUser.id,
      });

      const frontendUrl =
        process.env.FRONTEND_URL || 'http://localhost:5173';
      const callbackUrl = new URL('/auth/callback', frontendUrl);
      callbackUrl.searchParams.set('token', jwt);
      callbackUrl.searchParams.set('redirect', pending.redirect);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.status(500).json({ error: 'OAuth authentication failed' });
    }
  });

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
        githubUsername: user.githubUsername,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        roles: user.roles,
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

  app.post('/usage', async (req, res) => {
    const result = await controller.operations.createUsageEvent(req.body);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

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

  app.post('/reload', async (_req, res) => {
    try {
      await controller.startup();
      res.json({ ok: true });
    } catch (err) {
      console.error('Reload error:', err);
      res.status(500).json({ error: 'Reload failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // GitHub App webhook
  // ---------------------------------------------------------------------------

  app.post('/github/webhook', async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sig) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const expected = `sha256=${crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex')}`;
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const event = req.headers['x-github-event'] as string | undefined;
    const { action, installation } = req.body ?? {};

    if (event === 'installation' && installation?.id) {
      const ghOrgLogin: string | undefined = installation.account?.login;
      if (ghOrgLogin) {
        if (action === 'created') {
          const updated = await db.organization.updateMany({
            where: { domain: ghOrgLogin, githubInstallationId: null },
            data: { githubInstallationId: installation.id },
          });
          if (updated.count > 0) {
            console.log(`[webhook] Linked GitHub App installation ${installation.id} → org "${ghOrgLogin}"`);
          } else {
            console.warn(`[webhook] No unlinked org found with domain "${ghOrgLogin}"`);
          }
        } else if (action === 'deleted') {
          await db.organization.updateMany({
            where: { githubInstallationId: installation.id },
            data: { githubInstallationId: null },
          });
          console.log(`[webhook] Unlinked GitHub App installation ${installation.id} (org "${ghOrgLogin}")`);
        }
      }
    }

    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // MCP endpoint (Streamable HTTP transport)
  // ---------------------------------------------------------------------------

  app.post('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.get('/mcp', async (req, res) => {
    await handleMcpRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    await handleMcpDelete(req, res);
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}
