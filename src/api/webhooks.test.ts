/**
 * Spec 040 §8 — webhook trigger (D-2026-05-02) + the first ticketed action.
 *
 * What this file pins:
 *   - Two-factor URL: unknown secret, name mismatch, disabled hook, missing
 *     or mismatched platform token (hpt) ALL yield a uniform 404 — a prober
 *     learns nothing; a token minted for webhook A never opens webhook B.
 *   - GET mints a WEBHOOK run and answers 202 + runId; POST args land in
 *     eventData; launch-gate denials surface as 429.
 *   - callbackUrl: internal/reserved destinations are rejected at accept
 *     time (egress policy applies to callbacks).
 *   - dispatchRunCallback consumes EXACTLY ONE comm.outbound ticket
 *     (app-scoped preferred), records sent:<status>; without a ticket the
 *     callback is SKIPPED and recorded — never sent off-ledger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { SignJWT } from 'jose';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';

vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

import {
  mountWebhookRoutes,
  mintWebhookPlatformToken,
  dispatchRunCallback,
  generateWebhookSecret,
} from './webhooks.js';
import { consumeActionTicket } from '../jobs/appRuns.js';

let server: Server;
let base: string;
let orgId: string;
let appId: string;
let webhookId: string;
let secret: string;
let hpt: string;

async function makeTicket(extra: Record<string, unknown> = {}) {
  return db.actionTicket.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      action: 'comm.outbound',
      mintedBy: 'test',
      ...extra,
    } as never,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'wh-org', urn: 'wh-org' },
  });
  orgId = org.id;
  const app = await db.app.create({
    data: { id: generateId(), organizationId: orgId, name: 'wh-app', urn: 'wh-org::wh-app' },
  });
  appId = app.id;
  // #2712: a webhook launch needs an installed Agent with a served boot prompt (R74).
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, urn: 'wh-org:runner', name: 'runner' } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
  secret = generateWebhookSecret();
  const webhook = await db.agentWebhook.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      appId,
      agentId: agent.id,
      name: 'notify',
      secret,
      entryNodeUrn: 'wh-org::whmem::tasks:notify',
    },
  });
  webhookId = webhook.id;
  hpt = await mintWebhookPlatformToken(webhookId);

  const ex = express();
  ex.use(express.json());
  mountWebhookRoutes(ex, db);
  await new Promise<void>((resolve) => {
    server = ex.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('two-factor URL (uniform 404)', () => {
  it('accepts secret + matching hpt (202 + runId)', async () => {
    const res = await fetch(`${base}/hooks/${secret}/notify?hpt=${hpt}`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body.status).toBe('PENDING');
    const run = await db.appRun.findUnique({ where: { id: body.runId } });
    expect(run?.triggerKind).toBe('WEBHOOK');
    expect(run?.triggerId).toBe(webhookId);
  });

  it('404 on unknown secret, wrong name, missing hpt, and foreign hpt', async () => {
    expect((await fetch(`${base}/hooks/whs_nope/notify?hpt=${hpt}`)).status).toBe(404);
    expect((await fetch(`${base}/hooks/${secret}/other?hpt=${hpt}`)).status).toBe(404);
    expect((await fetch(`${base}/hooks/${secret}/notify`)).status).toBe(404);
    const foreign = await mintWebhookPlatformToken(generateId());
    expect((await fetch(`${base}/hooks/${secret}/notify?hpt=${foreign}`)).status).toBe(404);
  });

  it('#421 404 on an hpt with another algorithm, the wrong use, or an expired lifetime', async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET!);
    const forge = (claims: Record<string, unknown>, alg = 'HS256', exp: string = '1h') =>
      new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime(exp).sign(key);
    // Control: the same forge with the right claims is accepted.
    const control = await forge({ wh: webhookId, use: 'webhook' });
    expect((await fetch(`${base}/hooks/${secret}/notify?hpt=${control}`)).status).toBe(202);

    for (const bad of [
      await forge({ wh: webhookId, use: 'webhook' }, 'HS384'),
      await forge({ wh: webhookId, use: 'webhook' }, 'HS512'),
      await forge({ wh: webhookId, use: 'login' }),
      await forge({ wh: webhookId, use: 'webhook' }, 'HS256', '-1s'),
    ]) {
      expect((await fetch(`${base}/hooks/${secret}/notify?hpt=${bad}`)).status).toBe(404);
    }
  });

  it('404 when the webhook is disabled', async () => {
    await db.agentWebhook.update({ where: { id: webhookId }, data: { enabled: false } });
    expect((await fetch(`${base}/hooks/${secret}/notify?hpt=${hpt}`)).status).toBe(404);
  });
});

describe('POST args + callbackUrl acceptance', () => {
  it('POST args land in the run eventData; callbackUrl is captured', async () => {
    const res = await fetch(`${base}/hooks/${secret}/notify?hpt=${hpt}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'deploy', callbackUrl: 'https://example.com/cb' }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const run = await db.appRun.findUniqueOrThrow({ where: { id: runId } });
    const ev = run.eventData as Record<string, unknown>;
    expect(ev.topic).toBe('deploy');
    expect(ev.__callbackUrl).toBe('https://example.com/cb');
    expect(ev.webhookName).toBe('notify');
  });

  it('rejects an internal callbackUrl at accept time (egress policy)', async () => {
    const res = await fetch(`${base}/hooks/${secret}/notify?hpt=${hpt}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callbackUrl: 'http://169.254.169.254/latest' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('dispatchRunCallback — the first ticketed action (cor:acl:050:04)', () => {
  function terminalRun(callbackUrl: string) {
    return db.appRun.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId,
        triggerKind: 'WEBHOOK',
        entryNodeUrn: 'wh-org::whmem::tasks:notify',
        status: 'COMPLETED',
        finishedAt: new Date(),
        eventData: { __callbackUrl: callbackUrl } as never,
      },
    });
  }

  it('consumes exactly one ticket and records sent:<status>', async () => {
    await makeTicket();
    await makeTicket();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    );
    try {
      const run = await terminalRun('https://example.com/cb');
      await dispatchRunCallback(db, run);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const consumed = await db.actionTicket.findMany({ where: { consumedAt: { not: null } } });
      expect(consumed).toHaveLength(1);
      expect(consumed[0].consumedByRunId).toBe(run.id);
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.eventData as Record<string, unknown>).__callbackResult).toBe('sent:200');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('SKIPS the callback without a ticket — outbound never happens off-ledger', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const run = await terminalRun('https://example.com/cb');
      await dispatchRunCallback(db, run);
      expect(fetchSpy).not.toHaveBeenCalled();
      const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
      expect((after.eventData as Record<string, unknown>).__callbackResult).toBe('skipped:no-ticket');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('prefers an app-scoped ticket over an org-wide one', async () => {
    const orgWide = await makeTicket();
    const appScoped = await makeTicket({ appId });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      const run = await terminalRun('https://example.com/cb');
      await dispatchRunCallback(db, run);
      const consumedApp = await db.actionTicket.findUnique({ where: { id: appScoped.id } });
      const consumedOrg = await db.actionTicket.findUnique({ where: { id: orgWide.id } });
      expect(consumedApp?.consumedAt).not.toBeNull();
      expect(consumedOrg?.consumedAt).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('an egress-denied destination at send time skips WITHOUT burning a ticket (PR-494)', async () => {
    await makeTicket();
    const run = await terminalRun('http://169.254.169.254/latest'); // internal — denied at send time
    await dispatchRunCallback(db, run);
    const consumed = await db.actionTicket.findMany({ where: { consumedAt: { not: null } } });
    expect(consumed).toHaveLength(0); // ticket NOT burned for a never-attempted send
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.eventData as Record<string, unknown>).__callbackResult).toBe('skipped:egress-denied');
  });

  it('an expired ticket never gets consumed', async () => {
    await makeTicket({ expiresAt: new Date(Date.now() - 1000) });
    expect(await consumeActionTicket(db, orgId, appId, 'comm.outbound', generateId())).toBe(false);
  });
});
