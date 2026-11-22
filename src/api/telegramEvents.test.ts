/**
 * #597 (Telegram phase 2) — the tool → core Telegram events ingress, POST /internal/telegram-events, a sibling of
 * emailEvents/slackEvents. Pins: unset CORE_EVENTS_TOKEN is 503; a missing or wrong bearer is 401; a malformed body is
 * 400; a valid event is acknowledged 202; a replayed (toolConnectionId, eventId) is acknowledged and dispatched ONCE,
 * even when two deliveries race; an unknown toolConnectionId is logged and dropped (still 202, no receipt consumer);
 * a dispatch that throws releases its claim so the tool's retry re-runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import {
  mountTelegramEventRoutes,
  dispatchTelegramEvent,
  pruneTelegramEventReceipts,
  telegramEventConsumer,
  type InboundTelegramEvent,
} from './telegramEvents.js';

let server: Server;
let base: string;

function event(overrides: Partial<InboundTelegramEvent> = {}): InboundTelegramEvent {
  return {
    event: 'telegram.message.received',
    connectionId: 'tool-conn-tg',
    eventId: 'upd-1',
    chatId: '555',
    text: 'hello',
    ...overrides,
  };
}

async function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/internal/telegram-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function seedConnection(toolConnectionId = 'tool-conn-tg'): Promise<{ id: string }> {
  const slug = `tg-${generateId()}`;
  const org = await db.organization.create({ data: { id: generateId(), name: slug, urn: slug } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'tg-app', urn: `${slug}::tg-app` } });
  return db.telegramConnection.create({
    data: {
      organizationId: org.id,
      appId: app.id,
      toolConnectionId,
      botId: `bot-${toolConnectionId}`,
      botUsername: 'IrisBot',
      displayName: 'Iris',
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  telegramEventConsumer.handler = vi.fn().mockResolvedValue(undefined);
  process.env.CORE_EVENTS_TOKEN = 'events-secret';
  const app = express();
  app.use(express.json());
  mountTelegramEventRoutes(app);
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

describe('POST /internal/telegram-events', () => {
  it('503s when the plane is not configured (CORE_EVENTS_TOKEN unset)', async () => {
    delete process.env.CORE_EVENTS_TOKEN;
    expect((await post(event(), 'events-secret')).status).toBe(503);
  });

  it('401s a missing or wrong bearer, and dispatches nothing', async () => {
    await seedConnection();
    expect((await post(event())).status).toBe(401);
    expect((await post(event(), 'wrong')).status).toBe(401);
    expect(telegramEventConsumer.handler).not.toHaveBeenCalled();
    expect(await db.telegramEventReceipt.count()).toBe(0);
  });

  it('400s a malformed payload (no eventId, no connectionId, a non-telegram kind)', async () => {
    expect((await post({ ...event(), eventId: undefined }, 'events-secret')).status).toBe(400);
    expect((await post({ ...event(), connectionId: '' }, 'events-secret')).status).toBe(400);
    expect((await post({ ...event(), event: 'slack.command' }, 'events-secret')).status).toBe(400);
  });

  it('202s a valid event and hands it to the dispatch seam once, with the resolved connection', async () => {
    const conn = await seedConnection();
    expect((await post(event(), 'events-secret')).status).toBe(202);
    expect(telegramEventConsumer.handler).toHaveBeenCalledTimes(1);
    const [ev, connection] = vi.mocked(telegramEventConsumer.handler).mock.calls[0]!;
    expect(ev.eventId).toBe('upd-1');
    expect(connection.id).toBe(conn.id);
  });

  it('a replayed event id is acknowledged (202) and dispatched once', async () => {
    await seedConnection();
    expect((await post(event({ eventId: 'dup' }), 'events-secret')).status).toBe(202);
    expect((await post(event({ eventId: 'dup' }), 'events-secret')).status).toBe(202);
    expect(telegramEventConsumer.handler).toHaveBeenCalledTimes(1);
    expect(await db.telegramEventReceipt.count()).toBe(1);
  });

  it('an unknown toolConnectionId is logged and dropped: 202, no consumer', async () => {
    const res = await post(event({ connectionId: 'foreign-tool' }), 'events-secret');
    expect(res.status).toBe(202);
    expect(telegramEventConsumer.handler).not.toHaveBeenCalled();
  });

  it('a soft-deleted connection is as unknown as a missing one', async () => {
    const conn = await seedConnection();
    await db.telegramConnection.update({ where: { id: conn.id }, data: { deletedAt: new Date() } });
    expect((await post(event(), 'events-secret')).status).toBe(202);
    expect(telegramEventConsumer.handler).not.toHaveBeenCalled();
  });
});

describe('dispatchTelegramEvent', () => {
  it('two concurrent deliveries of one event id dispatch once (the claim is the unique insert)', async () => {
    await seedConnection();
    await Promise.all([dispatchTelegramEvent(event({ eventId: 'race' })), dispatchTelegramEvent(event({ eventId: 'race' }))]);
    expect(telegramEventConsumer.handler).toHaveBeenCalledTimes(1);
    expect(await db.telegramEventReceipt.count()).toBe(1);
  });

  it('the same event id on DIFFERENT tool connections is not a duplicate', async () => {
    await seedConnection('tool-conn-tg');
    await dispatchTelegramEvent(event({ eventId: 'x' }));
    await seedConnection('other-tool');
    await dispatchTelegramEvent(event({ eventId: 'x', connectionId: 'other-tool' }));
    expect(telegramEventConsumer.handler).toHaveBeenCalledTimes(2);
    expect(await db.telegramEventReceipt.count()).toBe(2);
  });

  it('a consumer that throws releases the claim, so the tool\'s retry runs it again', async () => {
    await seedConnection();
    vi.mocked(telegramEventConsumer.handler).mockRejectedValueOnce(new Error('boom'));
    await expect(dispatchTelegramEvent(event({ eventId: 'retry' }))).rejects.toThrow('boom');
    expect(await db.telegramEventReceipt.count()).toBe(0);
    await dispatchTelegramEvent(event({ eventId: 'retry' }));
    expect(telegramEventConsumer.handler).toHaveBeenCalledTimes(2);
    expect(await db.telegramEventReceipt.count()).toBe(1);
  });

  it('pruneTelegramEventReceipts sweeps only expired rows', async () => {
    await db.telegramEventReceipt.create({ data: { connectionId: 'c1', eventId: 'old', createdAt: new Date('2026-07-01T00:00:00Z') } });
    await db.telegramEventReceipt.create({ data: { connectionId: 'c1', eventId: 'fresh' } });
    expect(await pruneTelegramEventReceipts(new Date('2026-07-08T00:00:00Z'))).toBe(1);
    expect((await db.telegramEventReceipt.findMany()).map((r) => r.eventId)).toEqual(['fresh']);
  });
});
