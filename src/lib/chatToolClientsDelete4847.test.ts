/**
 * #4847: the tool clients' delete calls now REPORT whether the tool confirmed. A success (2xx) is the only confirmation; a not-found
 * (the tool already dropped it, which today it answers as an error: hadrontool-telegram#8, hadrontool-slack#6), any other status, a
 * network failure and an unset URL are all "not confirmed". Neither client ever throws (the doors' contract).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTelegramToolConnection } from './telegramClient.js';
import { deleteSlackToolConnection } from './slackClient.js';

const cases = [
  ['telegram', deleteTelegramToolConnection, 'TELEGRAM_TOOL_URL', 'TELEGRAM_TOOL_TOKEN'],
  ['slack', deleteSlackToolConnection, 'SLACK_TOOL_URL', 'SLACK_TOOL_TOKEN'],
] as const;

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const [, , url, tok] of cases) { delete process.env[url]; delete process.env[tok]; } });

describe.each(cases)('%s delete client reports whether the tool confirmed', (provider, del, urlEnv, tokEnv) => {
  const configured = () => { process.env[urlEnv] = 'http://tool.test:8080/'; };
  it('a 200 is confirmed, and it sends DELETE to the connection id with the bearer when set', async () => {
    configured();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"deleted":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(del(provider, 'tool-1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://tool.test:8080/connections/tool-1', expect.objectContaining({ method: 'DELETE' }));
  });
  it('#4945: it sends the shared bearer when one is set, and no Authorization header when none is', async () => {
    configured();
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"deleted":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env[tokEnv] = 'tool-secret-4945';
    await del(provider, 'tool-1');
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ authorization: 'Bearer tool-secret-4945' });
    delete process.env[tokEnv];
    await del(provider, 'tool-1');
    expect(fetchMock.mock.calls[1]![1].headers).toEqual({});
  });
  it('a 404 (not found) is NOT a confirmation', async () => {
    configured();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"not_found"}', { status: 404 })));
    await expect(del(provider, 'tool-1')).resolves.toBe(false);
  });
  it('a 500, a network failure and an unset URL are not confirmations, and nothing throws', async () => {
    configured();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(del(provider, 'tool-1')).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(del(provider, 'tool-1')).resolves.toBe(false);
    delete process.env[urlEnv];
    await expect(del(provider, 'tool-1')).resolves.toBe(false);
  });
});
