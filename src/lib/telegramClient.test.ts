/**
 * #597 (Telegram phase 2) — the Telegram tool client (src/lib/telegramClient.ts), on the emailClient / slackClient
 * PROVIDER_TOOLS pattern. Pins: an unset TELEGRAM_TOOL_URL is the typed TELEGRAM_TOOL_NOT_CONFIGURED before any
 * request; the bearer is sent only when TELEGRAM_TOOL_TOKEN is set; the tool's typed codes pass through; the identity
 * is shape-validated; and the bot token never survives into an error (message or extensions).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTelegramToolConnection,
  deleteTelegramToolConnection,
  runTelegramOperation,
} from './telegramClient.js';

const TOKEN = '123456:SECRET-bot-token';
const identity = { id: 'tool-1', provider: 'telegram', botId: '99', botUsername: 'IrisBot', displayName: 'Iris', status: 'ACTIVE' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; message: string; ext: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message: string; extensions?: Record<string, unknown> };
    return { code: e.extensions?.code as string | undefined, message: e.message, ext: e.extensions ?? {} };
  }
  throw new Error('expected a rejection');
}

beforeEach(() => {
  process.env.TELEGRAM_TOOL_URL = 'http://telegram-tool.test:8080/';
  delete process.env.TELEGRAM_TOOL_TOKEN;
});
afterEach(() => {
  delete process.env.TELEGRAM_TOOL_URL;
  delete process.env.TELEGRAM_TOOL_TOKEN;
  vi.unstubAllGlobals();
});

describe('telegramClient', () => {
  it('an unset TELEGRAM_TOOL_URL is TELEGRAM_TOOL_NOT_CONFIGURED, and no request is made', async () => {
    delete process.env.TELEGRAM_TOOL_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const e = await codeOf(createTelegramToolConnection('telegram', { botToken: TOKEN }));
    expect(e.code).toBe('TELEGRAM_TOOL_NOT_CONFIGURED');
    expect((await codeOf(runTelegramOperation('telegram', 'send-message', {}))).code).toBe('TELEGRAM_TOOL_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unknown provider is TELEGRAM_TOOL_NOT_CONFIGURED', async () => {
    expect((await codeOf(runTelegramOperation('nope', 'x', {}))).code).toBe('TELEGRAM_TOOL_NOT_CONFIGURED');
  });

  it('registers on POST /connections, sends the bearer only when set, and returns the validated identity', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, identity));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createTelegramToolConnection('telegram', { botToken: TOKEN })).toEqual(identity);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://telegram-tool.test:8080/connections');
    expect(JSON.parse(init.body)).toEqual({ botToken: TOKEN });
    expect(init.headers.authorization).toBeUndefined();

    process.env.TELEGRAM_TOOL_TOKEN = 'shared';
    await createTelegramToolConnection('telegram', { botToken: TOKEN });
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe('Bearer shared');
  });

  it('rejects an identity with an empty id or botId (it would become a routing key)', async () => {
    for (const bad of [{ ...identity, id: '' }, { ...identity, botId: ' ' }, { ...identity, provider: 'other' }]) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(200, bad)));
      expect((await codeOf(createTelegramToolConnection('telegram', { botToken: TOKEN }))).code).toBe('TELEGRAM_TOOL_ERROR');
    }
  });

  it('passes the tool\'s typed code through as telegramErrorCode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jsonResponse(422, { error: 'invalid_token', message: 'The bot token was rejected.' })));
    const e = await codeOf(createTelegramToolConnection('telegram', { botToken: TOKEN }));
    expect(e.code).toBe('TELEGRAM_TOOL_ERROR');
    expect(e.ext.telegramErrorCode).toBe('invalid_token');
    expect(e.ext.status).toBe(422);
  });

  it('never lets the bot token into an error: a tool message that echoes it is scrubbed, in message and extensions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(401, { error: `bad ${TOKEN}`, message: `Unauthorized: ${TOKEN} was rejected` })),
    );
    const e = await codeOf(createTelegramToolConnection('telegram', { botToken: TOKEN }));
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(JSON.stringify(e)).not.toContain('SECRET-bot-token');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`connect failed for ${TOKEN}`)));
    const u = await codeOf(createTelegramToolConnection('telegram', { botToken: TOKEN }));
    expect(u.code).toBe('TELEGRAM_TOOL_UNREACHABLE');
    expect(JSON.stringify(u)).not.toContain('SECRET-bot-token');
  });

  it('disconnect is best effort: it never throws, unconfigured or unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(deleteTelegramToolConnection('telegram', 'tool-1')).resolves.toBeUndefined();
    delete process.env.TELEGRAM_TOOL_URL;
    await expect(deleteTelegramToolConnection('telegram', 'tool-1')).resolves.toBeUndefined();
  });
});
