/**
 * #4471 BLIND P2-4 — the MCP claim, pinned instead of asserted.
 *
 * mcp/server.ts's authenticateBoundMcpSession resolves the credential through the same
 * middleware and guards it with an UNTYPED catch-all that predates #4471: any rejection
 * answers the fixed 503 "Authentication temporarily unavailable" and binds no session. Because
 * the catch has no type filter, the typed AuthStoreBusyError changes nothing on this surface —
 * by construction. This pin proves it for BOTH the typed fault and the raw driver error it
 * replaced: byte-identical answers, no driver text, null.
 *
 * The credential middleware is mocked (its real db lookup is not this test's subject); the
 * catch under test is the SUT's own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { Prisma } from '../generated/prisma/index.js';
import { AuthStoreBusyError } from '../lib/authStoreBusy.js';

vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  resolveCredentialContextWithStatus: vi.fn(),
}));

import { authenticateBoundMcpSession } from './server.js';
import { resolveCredentialContextWithStatus } from '../middleware/auth.js';

const p2024 = () => new Prisma.PrismaClientKnownRequestError(
  'Timed out fetching a new connection from the pool.',
  { code: 'P2024', clientVersion: '6.19.2' },
);

const fakeReq = () => ({ headers: { authorization: 'Bearer hk_user_0000000000000000000000000000000000000000000000000000000000000000' } }) as unknown as Request;

function fakeRes() {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    setHeader: vi.fn(),
  };
  return { res: res as unknown as Response, state };
}

describe('a busy store during MCP session authentication (#4471)', () => {
  it.each([
    ['the typed AuthStoreBusyError', () => new AuthStoreBusyError(p2024(), 'POOL_WAIT')],
    ['the raw P2024 it replaced', () => p2024()],
  ])('%s answers the same fixed 503 — the catch-all is untyped, the surface unchanged', async (_name, reject) => {
    vi.mocked(resolveCredentialContextWithStatus).mockRejectedValueOnce(reject());
    const { res, state } = fakeRes();
    // The transport arg is never read on this path (the mocked credential
    // resolver rejects before any access); ActiveMcpTransport is a server.ts-local
    // structural type wanting a full transport+auth graph, so this is the one
    // "#4519: typed fixtures where cheap" cast that is deliberately not cheap.
    const ctx = await authenticateBoundMcpSession(fakeReq(), res, 'sess-1', {} as never);
    // No session is bound on a fault — a transport check that cannot run is never a verdict.
    expect(ctx).toBeNull();
    expect(state.status).toBe(503);
    expect(state.body).toEqual({ error: 'Authentication temporarily unavailable' });
    // Neither the driver text nor the typed code leaks into this fixed answer.
    expect(JSON.stringify(state.body)).not.toMatch(/P2024|Timed out fetching|AUTH_STORE_BUSY/i);
  });
});
