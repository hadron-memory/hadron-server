/**
 * Spec 025-oauth-for-mcp FR-007 — `/auth/github` Option-C `return_to`
 * integration tests.
 *
 * Spins up the real Express app from `createServer()` on a random port
 * and drives requests over HTTP. Asserts on the redirect / 400
 * behavior of the GET endpoint; doesn't exercise the callback's
 * cookie-set path because the callback exchanges with GitHub's API
 * (would require mocking out an external dependency to test
 * end-to-end). The predicate exhaustive unit tests live alongside
 * the predicate at `src/auth/server-local-path.test.ts`.
 *
 * Task: T019 per tasks.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from '../../server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // createServer() returns the Express app. Wrap it in a Node HTTP
  // server so we can bind a random port and tear down cleanly.
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/**
 * Drive a request against /auth/github with redirects DISABLED so we
 * can inspect the immediate response (the GET is supposed to issue a
 * 302 to GitHub on the happy path; following it would hit the real
 * GitHub auth URL which we don't want in tests).
 */
async function getAuthGithub(qs: string): Promise<Response> {
  return fetch(`${baseUrl}/auth/github${qs}`, { redirect: 'manual' });
}

describe('/auth/github GET — Option-C return_to (FR-007)', () => {
  // ── Accepted: server-local paths ──────────────────────────────────

  it('accepts return_to=/oauth/authorize?state=abc (server-local with query)', async () => {
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('/oauth/authorize?state=abc'),
    );
    // Happy path: 302 to GitHub's auth URL with state.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/github\.com\/login\/oauth\/authorize/);
  });

  it('accepts return_to=/ (root path)', async () => {
    const res = await getAuthGithub('?return_to=' + encodeURIComponent('/'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/github\.com/);
  });

  it('accepts the portal handoff path (client_state, no return_to)', async () => {
    // #477: the portal-handoff flow (no return_to) now carries a client_state
    // nonce; that is the happy path to GitHub.
    const res = await getAuthGithub('?client_state=' + 'a'.repeat(64));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/github\.com/);
  });

  it('rejects a bare start with no return_to and no client_state (#477 fixation binding)', async () => {
    // Hitting the backend URL directly (no return_to, no client_state) would
    // mint an UNBOUND login code — the session-fixation vector. Must 400.
    const res = await getAuthGithub('');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/client_state is required/);
  });

  // ── Rejected: open-redirect to external origin ────────────────────

  it('rejects return_to=https://evil.example with 400', async () => {
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('https://evil.example/grab-cookie'),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid return_to/);
  });

  // ── Rejected: protocol-relative ───────────────────────────────────

  it('rejects return_to=//evil.example with 400', async () => {
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('//evil.example/grab-cookie'),
    );
    expect(res.status).toBe(400);
  });

  // ── Rejected: backslash-normalization trick ───────────────────────

  it('rejects return_to=/\\evil.example (backslash) with 400', async () => {
    // Browser would normalize /\evil.example to //evil.example (per
    // WHATWG URL parsing), turning a backslash-leading "path" into a
    // protocol-relative URL pointing at evil.example.
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('/\\evil.example'),
    );
    expect(res.status).toBe(400);
  });

  // ── Rejected: protocol-injection schemes ──────────────────────────

  it('rejects return_to=javascript:alert(1) with 400', async () => {
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('javascript:alert(1)'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects return_to=data:text/html,<script>… with 400', async () => {
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('data:text/html,<script>alert(1)</script>'),
    );
    expect(res.status).toBe(400);
  });

  // ── Negative control: cookie lifecycle ────────────────────────────

  it('does NOT set the hadron_token cookie on the /auth/github GET response', async () => {
    // The Option-C cookie is written only on the callback response,
    // not on the initial /auth/github redirect to GitHub. A regression
    // where the cookie leaked to the GET response would mean the
    // server hands out the cookie without the user actually
    // completing GitHub auth.
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('/oauth/authorize'),
    );
    expect(res.status).toBe(302);
    // No Set-Cookie header (or at least no hadron_token cookie).
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      expect(setCookie).not.toMatch(/\bhadron_token\b/);
    }
  });

  // ── Control-byte rejection (CRLF injection class) ─────────────────

  it('rejects return_to with embedded newline (CRLF-injection class)', async () => {
    // Express URL-decodes %0A from query strings; without the
    // predicate's control-byte filter (PR #149 review), this would
    // pass to res.redirect() and crash Node's HTTP layer with a 500.
    // The predicate now produces a clean 400 instead.
    const res = await getAuthGithub(
      '?return_to=' + encodeURIComponent('/foo\r\nLocation: //evil.example'),
    );
    expect(res.status).toBe(400);
  });
});
