import { describe, expect, it } from 'vitest';
import { assignRequestId, bindRequestId, currentRequestId } from './requestContext.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeRes() {
  const headers = new Map<string, string>();
  return { headers, locals: {} as Record<string, unknown>, setHeader: (k: string, v: string) => void headers.set(k, v) };
}

describe('request id (#1789)', () => {
  it('assigns a server-generated UUIDv4, sets X-Request-Id, and never trusts an incoming id', () => {
    const res = fakeRes();
    const req = { headers: { 'x-request-id': 'attacker-chosen' } };
    assignRequestId(req as never, res as never, () => {});
    const id = res.headers.get('X-Request-Id')!;
    expect(id).toMatch(UUID_V4);
    expect(id).not.toBe('attacker-chosen');
    expect(res.locals.requestId).toBe(id);
  });

  it('two requests get distinct ids', () => {
    const a = fakeRes(); const b = fakeRes();
    assignRequestId({ headers: {} } as never, a as never, () => {});
    assignRequestId({ headers: {} } as never, b as never, () => {});
    expect(a.locals.requestId).not.toBe(b.locals.requestId);
  });

  it('bindRequestId makes the id visible to async continuations, and only within the request', async () => {
    expect(currentRequestId()).toBeUndefined();
    const res = fakeRes();
    assignRequestId({ headers: {} } as never, res as never, () => {});
    const seen = await new Promise<(string | undefined)[]>((resolve) => {
      bindRequestId({} as never, res as never, async () => {
        const first = currentRequestId();
        await new Promise((r) => setTimeout(r, 1));
        resolve([first, currentRequestId()]);
      });
    });
    expect(seen).toEqual([res.locals.requestId, res.locals.requestId]);
    expect(currentRequestId()).toBeUndefined();
  });
});
