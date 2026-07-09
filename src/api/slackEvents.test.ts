/**
 * Spec 043 Phase 2 — the tool → core Slack events ingress.
 *
 * What this file pins:
 *   - Unset CORE_EVENTS_TOKEN ⇒ 503 (plane off, distinguishable from a
 *     wrong URL); wrong/missing bearer ⇒ 401; malformed payload ⇒ 400.
 *   - A valid event acks 202; dispatch resolves the TOOL's connection id to
 *     the core identity row; an unknown tool connection is dropped silently.
 *   - At-least-once dedupe: the same (connectionId, envelopeId) dispatches
 *     ONCE — the duplicate is dropped before any consumer runs.
 *   - slack.command answers the /hadron usage text via the tool's respond
 *     op (the Phase-2 acceptance round-trip); a failing respond call never
 *     errors the ingress.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { runSlackOperation } from '../lib/slackClient.js';
import {
  mountSlackEventRoutes,
  dispatchSlackEvent,
  pruneSlackEventReceipts,
  type InboundSlackEvent,
} from './slackEvents.js';

vi.mock('../lib/slackClient.js', () => ({
  runSlackOperation: vi.fn().mockResolvedValue({ ok: true }),
}));

let server: Server;
let base: string;

function commandEvent(overrides: Partial<InboundSlackEvent> = {}): InboundSlackEvent {
  return {
    event: 'slack.command',
    connectionId: 'tool-conn-slack',
    envelopeId: 'env-1',
    teamId: 'T0001',
    channelId: 'C0123',
    slackUserId: 'U0HUMAN',
    command: '/hadron',
    text: 'help',
    responseUrl: 'https://hooks.slack.test/r/1',
    triggerId: 'trig-1',
    ...overrides,
  };
}

async function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/internal/slack-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Seed an org + app + SlackConnection whose toolConnectionId matches the fixture events. */
async function seedConnection(): Promise<{ id: string }> {
  const org = await db.organization.create({ data: { id: generateId(), name: 'slk-org', urn: 'slk-org' } });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'slk-app', urn: 'slk-org::slk-app' },
  });
  return db.slackConnection.create({
    data: {
      organizationId: org.id,
      defaultAppId: app.id,
      toolConnectionId: 'tool-conn-slack',
      teamId: 'T0001',
      teamName: 'Acme',
      botUserId: 'U0BOT',
      botId: 'B0BOT',
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(runSlackOperation).mockClear();
  vi.mocked(runSlackOperation).mockResolvedValue({ ok: true });
  process.env.CORE_EVENTS_TOKEN = 'events-secret';
  const app = express();
  app.use(express.json());
  mountSlackEventRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  delete process.env.CORE_EVENTS_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('POST /internal/slack-events', () => {
  it('503s when the plane is not configured', async () => {
    delete process.env.CORE_EVENTS_TOKEN;
    const res = await post(commandEvent(), 'events-secret');
    expect(res.status).toBe(503);
  });

  it('401s a missing or wrong bearer', async () => {
    expect((await post(commandEvent())).status).toBe(401);
    expect((await post(commandEvent(), 'wrong')).status).toBe(401);
  });

  it('400s a malformed payload (missing envelopeId)', async () => {
    const bad = { ...commandEvent(), envelopeId: undefined };
    expect((await post(bad, 'events-secret')).status).toBe(400);
    expect((await post({ event: 'slack.unknown' }, 'events-secret')).status).toBe(400);
  });

  it('202s a valid command and answers the usage text via the respond op', async () => {
    await seedConnection();
    const res = await post(commandEvent(), 'events-secret');
    expect(res.status).toBe(202);

    expect(runSlackOperation).toHaveBeenCalledTimes(1);
    const [provider, operation, input] = vi.mocked(runSlackOperation).mock.calls[0]!;
    expect(provider).toBe('slack');
    expect(operation).toBe('respond');
    expect(input).toMatchObject({ connectionId: 'tool-conn-slack', responseUrl: 'https://hooks.slack.test/r/1' });
    expect(String(input.text)).toContain('/hadron find');
  });

  it('drops an unknown tool connection silently (202, no consumer)', async () => {
    const res = await post(commandEvent({ connectionId: 'foreign-tool' }), 'events-secret');
    expect(res.status).toBe(202);
    expect(runSlackOperation).not.toHaveBeenCalled();
  });
});

describe('dispatchSlackEvent', () => {
  it('dedupes on (connectionId, envelopeId) — a redelivery never re-runs the consumer', async () => {
    await seedConnection();
    await dispatchSlackEvent(commandEvent({ envelopeId: 'env-dup' }));
    await dispatchSlackEvent(commandEvent({ envelopeId: 'env-dup' }));

    expect(runSlackOperation).toHaveBeenCalledTimes(1);
    expect(await db.slackEventReceipt.count()).toBe(1);
  });

  it('the same envelopeId on DIFFERENT connections is not a duplicate', async () => {
    await seedConnection();
    await dispatchSlackEvent(commandEvent({ envelopeId: 'env-x' }));
    await dispatchSlackEvent(commandEvent({ envelopeId: 'env-x', connectionId: 'other-tool-conn' }));
    expect(await db.slackEventReceipt.count()).toBe(2);
  });

  it('a failing respond call never errors dispatch (logged, receipt kept)', async () => {
    await seedConnection();
    vi.mocked(runSlackOperation).mockRejectedValueOnce(new Error('tool down'));
    await expect(dispatchSlackEvent(commandEvent({ envelopeId: 'env-fail' }))).resolves.toBeUndefined();
    expect(await db.slackEventReceipt.count()).toBe(1);
  });

  it('records the receipt only AFTER routing — a crash mid-route leaves none, so a retry re-processes', async () => {
    // Pin the order (PR #600 review, Gemini high + Codex P2): when the
    // consumer runs, no receipt may exist yet. Receipt-first would swallow
    // the event forever if the process died mid-route.
    await seedConnection();
    let receiptsAtRouteTime = -1;
    vi.mocked(runSlackOperation).mockImplementationOnce(async () => {
      receiptsAtRouteTime = await db.slackEventReceipt.count();
      return { ok: true };
    });
    await dispatchSlackEvent(commandEvent({ envelopeId: 'env-order' }));
    expect(receiptsAtRouteTime).toBe(0);
    expect(await db.slackEventReceipt.count()).toBe(1);
  });

  it('completes dispatch (clean gap consumer) and keeps the receipt', async () => {
    await seedConnection();
    await dispatchSlackEvent({
      event: 'slack.gap',
      connectionId: 'tool-conn-slack',
      envelopeId: 'gap:1',
      disconnectedAt: null,
      reconnectedAt: '2026-07-09T10:00:00Z',
    });
    expect(await db.slackEventReceipt.count()).toBe(1);
  });

  it('pruneSlackEventReceipts sweeps only expired rows', async () => {
    await db.slackEventReceipt.create({
      data: { connectionId: 'c1', envelopeId: 'old', createdAt: new Date('2026-07-01T00:00:00Z') },
    });
    await db.slackEventReceipt.create({ data: { connectionId: 'c1', envelopeId: 'fresh' } });
    const pruned = await pruneSlackEventReceipts(new Date('2026-07-08T00:00:00Z'));
    expect(pruned).toBe(1);
    const remaining = await db.slackEventReceipt.findMany();
    expect(remaining.map((r) => r.envelopeId)).toEqual(['fresh']);
  });

  it('message.received acks without a consumer (Phase 3 attaches there)', async () => {
    await seedConnection();
    await dispatchSlackEvent({
      event: 'slack.message.received',
      connectionId: 'tool-conn-slack',
      envelopeId: 'env-msg',
      teamId: 'T0001',
      channelId: 'C0123',
      threadTs: null,
      from: { slackUserId: 'U0HUMAN', botId: null, displayName: null },
      ts: '1783.5',
      text: 'hello',
    });
    expect(runSlackOperation).not.toHaveBeenCalled();
    expect(await db.slackEventReceipt.count()).toBe(1);
  });
});
