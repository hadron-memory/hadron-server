/**
 * Webhook trigger surface (spec 040 plan §8, D-2026-05-02).
 *
 * URL: /hooks/<secret>/<name>?hpt=<platform JWT>
 *   - The opaque secret is the lookup key — no app/agent IDs in the URL
 *     (D-2026-05-02-002).
 *   - The platform-issued, time-limited JWT (`hpt`) is the second factor:
 *     a leaked URL is useless without it (D-2026-05-02-006). The token's
 *     `wh` claim must match the secret-resolved webhook — the two factors
 *     are cryptographically tied together, not merely both-present.
 *   - GET fires with no args; POST takes a JSON body of args and an
 *     optional `callbackUrl` (D-2026-05-02-004). Response is ALWAYS
 *     202 Accepted with the runId; results arrive via the callback or the
 *     appRun audit query.
 *
 * The callback is the platform's first TICKETED action: dispatching it
 * consumes one `comm.outbound` ActionTicket (cor:acl:050:04) and the
 * destination passes the cor:api:130:02 egress policy. No ticket ⇒ the
 * callback is skipped (recorded on the run), never a run failure.
 */

import type { Express, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { PrismaClient, AppRun } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';
import { mintAppRun, RunLaunchDeniedError, consumeActionTicket } from '../jobs/appRuns.js';
import { assertUrlAllowed } from '../lib/webFetch.js';

const HPT_DEFAULT_TTL = process.env.WEBHOOK_TOKEN_TTL ?? '90d';
const CALLBACK_TIMEOUT_MS = 10_000;

function jwtSecret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required for webhook platform tokens.');
  return new TextEncoder().encode(s);
}

/** Mint the platform token (`hpt`) bound to one webhook. Shown once at create/rotate. */
export async function mintWebhookPlatformToken(webhookId: string): Promise<string> {
  return new SignJWT({ wh: webhookId, use: 'webhook' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(HPT_DEFAULT_TTL)
    .sign(jwtSecret());
}

/**
 * Verify an inbound platform token against the secret-resolved webhook.
 * Only VERIFICATION failures return false (uniform 404 upstream) — a
 * missing JWT_SECRET is a configuration error and throws loudly instead of
 * masquerading as not-found (PR-494 review).
 */
async function verifyWebhookPlatformToken(hpt: string, webhookId: string): Promise<boolean> {
  const secret = jwtSecret(); // config errors surface, not swallowed
  try {
    // #421: minted HS256 only; pinned so no other HS* on this key verifies.
    const { payload } = await jwtVerify(hpt, secret, { algorithms: ['HS256'] });
    return payload.use === 'webhook' && payload.wh === webhookId;
  } catch {
    return false;
  }
}

/** Mount the /hooks/:secret/:name trigger route (all methods; 405 except GET/POST). */
export function mountWebhookRoutes(app: Express, db: PrismaClient): void {
  app.all('/hooks/:secret/:name', (req, res) => {
    void handleWebhook(db, req, res).catch((err) => {
      console.error('[webhook] handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    });
  });
}

/**
 * The trigger request handler: resolve by secret → verify the bound
 * platform token → validate args/callbackUrl → launch gate → 202 + runId.
 * All auth failures are a uniform 404 (see module header).
 */
async function handleWebhook(db: PrismaClient, req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const { secret, name } = req.params as { secret: string; name: string };
  const webhook = await db.agentWebhook.findFirst({
    where: { secret, deletedAt: null },
  });
  // Uniform 404 for unknown secret, name mismatch, disabled, or bad token —
  // a prober learns nothing about which factor failed.
  const deny = () => res.status(404).json({ error: 'not found' });
  if (!webhook || webhook.name !== name || !webhook.enabled) {
    deny();
    return;
  }
  const hpt = typeof req.query.hpt === 'string' ? req.query.hpt : '';
  if (!hpt || !(await verifyWebhookPlatformToken(hpt, webhook.id))) {
    deny();
    return;
  }

  // POST body: args object + optional callbackUrl. Validated shallowly in
  // v1 (argsSchema enforcement via Ajv is a follow-on — plan §10).
  let args: Record<string, unknown> = {};
  let callbackUrl: string | undefined;
  if (req.method === 'POST' && req.body != null) {
    if (typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const { callbackUrl: cb, ...rest } = req.body as Record<string, unknown>;
    args = rest;
    if (cb != null) {
      if (typeof cb !== 'string') {
        res.status(400).json({ error: 'callbackUrl must be a string' });
        return;
      }
      // Egress policy applies to callbacks too (cor:api:130:02 posture) —
      // reject internal/reserved destinations at accept time, loudly.
      try {
        await assertUrlAllowed(cb);
      } catch {
        res.status(400).json({ error: 'callbackUrl is not an allowed destination' });
        return;
      }
      callbackUrl = cb;
    }
  }

  try {
    const run = await mintAppRun(db, {
      organizationId: webhook.organizationId,
      appId: webhook.appId,
      agentId: webhook.agentId,
      userId: webhook.userId,
      triggerKind: 'WEBHOOK',
      triggerId: webhook.id,
      entryNodeUrn: webhook.entryNodeUrn,
      entryNodeId: webhook.entryNodeId,
      eventData: {
        ...(webhook.eventData && typeof webhook.eventData === 'object' && !Array.isArray(webhook.eventData)
          ? (webhook.eventData as Record<string, unknown>)
          : {}),
        ...args,
        webhookName: webhook.name,
        ...(webhook.aiConfigName ? { __aiConfigName: webhook.aiConfigName } : {}),
        ...(callbackUrl ? { __callbackUrl: callbackUrl } : {}),
      },
      policy: webhook.policy,
      scopeId: webhook.scopeId,
      createdBy: webhook.createdBy,
    });
    await db.agentWebhook.updateMany({ where: { id: webhook.id }, data: { lastCalledAt: new Date() } });
    // ALWAYS 202 (D-2026-05-02-004): the work is asynchronous by contract.
    res.status(202).json({ runId: run.id, status: 'PENDING' });
  } catch (err) {
    if (err instanceof RunLaunchDeniedError) {
      // Launch-gate denials are visible to the caller (quota, policy) —
      // they hold a valid two-factor URL, so this is not an oracle.
      res.status(429).json({ error: err.code });
      return;
    }
    throw err;
  }
}

/**
 * Dispatch the terminal-status callback for a run, when one was requested.
 * The platform's first ticketed action: consumes one `comm.outbound`
 * ActionTicket; without a ticket the callback is SKIPPED and recorded —
 * outbound communication never happens off-ledger (cor:acl:050:04).
 */
export async function dispatchRunCallback(db: PrismaClient, run: AppRun): Promise<void> {
  const eventData =
    run.eventData && typeof run.eventData === 'object' && !Array.isArray(run.eventData)
      ? (run.eventData as Record<string, unknown>)
      : {};
  const callbackUrl = eventData.__callbackUrl;
  if (typeof callbackUrl !== 'string' || callbackUrl === '') return;

  const record = async (outcome: string) => {
    await db.appRun.updateMany({
      where: { id: run.id },
      data: { eventData: { ...eventData, __callbackResult: outcome } as never },
    });
  };

  // Send-time egress re-check BEFORE the ticket is touched — a destination
  // that became disallowed (DNS change, policy update) must not burn a
  // ticket for an attempt that never happens (PR-494 review).
  try {
    await assertUrlAllowed(callbackUrl);
  } catch {
    console.warn(`[webhook] run ${run.id}: callback destination no longer allowed`);
    await record('skipped:egress-denied');
    return;
  }

  const ticket = await consumeActionTicket(db, run.organizationId, run.appId, 'comm.outbound', run.id);
  if (!ticket) {
    console.warn(`[webhook] run ${run.id}: callback skipped — no comm.outbound ticket`);
    await record('skipped:no-ticket');
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
    try {
      // redirect: 'manual' — the egress policy was checked against THIS
      // destination only; following a 3xx could tunnel to an internal
      // address (PR-494 review, the fetchWebPage per-hop posture). A
      // redirecting callback endpoint gets its 3xx recorded, not followed.
      const resp = await fetch(callbackUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: run.id,
          status: run.status,
          resultNodeRef: run.curNodeUrn ?? null,
          finishedAt: run.finishedAt,
        }),
        signal: controller.signal,
      });
      // Drain/cancel the body — undici leaks sockets on unconsumed
      // responses (PR-494 review; matches webFetch).
      await resp.body?.cancel().catch(() => {});
      await record(`sent:${resp.status}`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Best-effort, once: a dead callback endpoint is the CALLER's problem —
    // the ticket is consumed (the outbound attempt happened).
    console.warn(`[webhook] run ${run.id}: callback failed:`, err);
    await record('failed');
  }
}

/** Generate a webhook secret: URL-safe, unguessable, prefixed for greppability. */
export function generateWebhookSecret(): string {
  return `whs_${generateId()}${generateId()}`;
}
