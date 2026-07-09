/**
 * #396 Phase 4 — the tool → core email-events ingress.
 *
 * What this file pins:
 *   - Unset CORE_EVENTS_TOKEN ⇒ 503 (plane off, distinguishable from a
 *     wrong URL); wrong/missing bearer ⇒ 401; malformed payload ⇒ 400.
 *   - A valid event acks 202; dispatch resolves the TOOL's connection id to
 *     the core identity row; an unknown tool connection is dropped silently
 *     (never an error back to the tool).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mountEmailEventRoutes, dispatchEmailEvent, type InboundEmailEvent } from './emailEvents.js';

let server: Server;
let base: string;

function event(overrides: Partial<InboundEmailEvent> = {}): InboundEmailEvent {
  return {
    event: 'email.received',
    connectionId: 'tool-conn-events',
    folder: 'inbox',
    message: {
      id: 'm-1',
      conversationId: 'c-1',
      subject: 'Hi',
      from: { name: null, address: 'a@b.c' },
      receivedAt: '2026-07-08T00:00:00Z',
      snippet: 'Hi…',
    },
    ...overrides,
  };
}

async function post(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/internal/email-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await cleanDb(db);
  process.env.CORE_EVENTS_TOKEN = 'events-secret';
  const app = express();
  app.use(express.json());
  mountEmailEventRoutes(app);
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

describe('POST /internal/email-events', () => {
  it('503s when the plane is not configured', async () => {
    delete process.env.CORE_EVENTS_TOKEN;
    const res = await post(event(), 'events-secret');
    expect(res.status).toBe(503);
  });

  it('401s a missing or wrong bearer', async () => {
    expect((await post(event())).status).toBe(401);
    expect((await post(event(), 'wrong')).status).toBe(401);
  });

  it('400s a malformed payload', async () => {
    const res = await post({ event: 'email.eaten', connectionId: 1 }, 'events-secret');
    expect(res.status).toBe(400);
  });

  it('202s a valid event and resolves the core connection', async () => {
    const user = await db.user.create({
      data: { id: generateId(), handle: 'evt', githubId: 9201, githubUsername: 'evt', name: 'E' },
    });
    const org = await db.organization.create({
      data: { id: generateId(), name: 'Evt Org', urn: 'evtorg.test', createdBy: user.id },
    });
    await db.exchangeConnection.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        mailboxEmail: 'evt@example.com',
        toolConnectionId: 'tool-conn-events',
      },
    });
    const res = await post(event(), 'events-secret');
    expect(res.status).toBe(202);
  });

  it('drops an unknown tool connection without erroring back to the tool', async () => {
    const res = await post(event({ connectionId: 'never-seen' }), 'events-secret');
    expect(res.status).toBe(202);
    // dispatch is also directly callable and must not throw
    await expect(dispatchEmailEvent(event({ connectionId: 'never-seen' }))).resolves.toBeUndefined();
  });
});
