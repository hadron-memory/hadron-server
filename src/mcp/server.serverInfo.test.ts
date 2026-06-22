/**
 * PR-C-diagnostics — #187 / #190 deployment-info surface.
 *
 * Pins:
 *   - getDeploymentInfo() reads BASE_URL and falls back to localhost:PORT
 *     (mirrors the pattern in src/auth/github.ts and src/auth/email.ts).
 *   - HADRON_SERVER_VERSION is exposed unchanged through both surfaces
 *     (no copy in the McpServer constructor — verified by grep so the
 *     hardcoded literal can't drift back in).
 *   - hadron_set_active_memory's success message includes the bound server
 *     URL + version inline.
 *   - hadron_server_info returns server + version, requires no auth context
 *     beyond the basic AuthContext shape, and does not expose
 *     DATABASE_URL (or any other credential-bearing value).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import {
  createTestableMcpServer,
  getDeploymentInfo,
  HADRON_SERVER_VERSION,
} from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// All env mutations in this file route through vi.stubEnv so a single
// vi.unstubAllEnvs() restores everything cleanly — direct
// `process.env.X = ...` / `delete process.env.X` would leak state to
// later test files sharing the same worker (Vitest reuses workers).
// PR-191 review (Gemini + Copilot) caught the prior pattern.

describe('getDeploymentInfo (#187 / #190 diagnostics)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns BASE_URL when set', () => {
    vi.stubEnv('BASE_URL', 'https://alpha.hadronmemory.com');
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('https://alpha.hadronmemory.com');
    expect(info.version).toBe(HADRON_SERVER_VERSION);
  });

  it('falls back to http://localhost:${PORT} when BASE_URL is unset (auth/* convention)', () => {
    vi.stubEnv('BASE_URL', undefined);
    vi.stubEnv('PORT', '4321');
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:4321');
  });

  it('falls back to http://localhost:4000 when both BASE_URL and PORT are unset', () => {
    vi.stubEnv('BASE_URL', undefined);
    vi.stubEnv('PORT', undefined);
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:4000');
  });

  it('treats BASE_URL="" as effectively-unset and falls back', () => {
    // Without this guard an empty BASE_URL silently propagates into
    // `server: ` lines — exactly the wrong-server-but-no-way-to-tell
    // symptom this surface exists to fix. Gemini review on PR-191
    // flagged it; pinned here.
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('PORT', '5000');
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:5000');
  });

  it('treats PORT="" as effectively-unset and falls back to 4000', () => {
    // Parallel to the BASE_URL="" guard above. PORT was previously
    // resolved with `??` which only catches null/undefined and lets
    // empty-string slip through, producing `http://localhost:`. PR-194
    // review caught it; pinned here.
    vi.stubEnv('BASE_URL', undefined);
    vi.stubEnv('PORT', '');
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:4000');
  });

  it('treats BASE_URL="/" as effectively-unset (Vitest globalSetup sentinel)', () => {
    // Mirrors src/auth/oauth.ts's special-case for the `"/"` sentinel
    // that Vitest's globalSetup leaves behind in test runs without an
    // explicit BASE_URL.
    vi.stubEnv('BASE_URL', '/');
    vi.stubEnv('PORT', '5001');
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:5001');
  });
});

describe('source audit — no hardcoded version literal in createMcpServerInstance', () => {
  it('only the exported HADRON_SERVER_VERSION constant carries the version string', () => {
    // Catches the historical drift mode: a contributor bumps the
    // constant but the McpServer constructor (or some other emission
    // site) keeps its own copy. With this audit any new hardcode is
    // loud at PR time.
    const src = readFileSync(
      new URL('./server.ts', import.meta.url),
      'utf8',
    );
    // Allowed: the const declaration itself.
    // Disallowed: any other `version: '...'` literal in the file.
    const lines = src.split('\n');
    const offenders: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match `version: '<digits.digits.digits>'` (the McpServer / package
      // version shape). Comments are tolerant: the audit lives in the
      // test file so callers reading the source can see why.
      if (/version:\s*['"`]\d+\.\d+\.\d+['"`]/.test(line)) {
        // Allow only the constant declaration site.
        if (/HADRON_SERVER_VERSION\s*=\s*['"`]/.test(line)) continue;
        offenders.push({ line: i + 1, text: line.trim() });
      }
    }
    expect(
      offenders,
      `Found hardcoded version literal(s) outside HADRON_SERVER_VERSION: ` +
        offenders.map((o) => `\n  src/mcp/server.ts:${o.line}: ${o.text}`).join(''),
    ).toEqual([]);
  });
});

describe('hadron_set_active_memory — includes deployment info in success message (#187 / #190)', () => {
  let admin: { id: string };
  let memory: { id: string; urn: string };

  beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({
      data: { id: generateId(), name: 'sm-org', urn: 'sm-org' },
    });
    admin = await db.user.create({
      data: { githubId: 9801, githubUsername: 'sm-admin', roles: ['ADMIN'] },
    });
    await db.orgMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
    memory = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'sm-mem' },
      { db, roles: ['ADMIN'], userId: admin.id } as Context,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('success message names the bound server URL and version', async () => {
    vi.stubEnv('BASE_URL', 'https://beta.hadronmemory.com');
    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('hadron_set_active_memory', {
      memoryUrn: memory.urn,
    });

    expect(text).toMatch(/Active memory set to:/);
    expect(text).toMatch(/server: https:\/\/beta\.hadronmemory\.com/);
    expect(text).toMatch(new RegExp(`version: ${HADRON_SERVER_VERSION}`));
  });
});

describe('hadron_server_info — returns server identity (#187 / #190)', () => {
  let admin: { id: string };

  beforeEach(async () => {
    await cleanDb(db);
    admin = await db.user.create({
      data: { githubId: 9802, githubUsername: 'si-admin', roles: ['ADMIN'] },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns server URL and version with no other side data', async () => {
    vi.stubEnv('BASE_URL', 'https://gamma.hadronmemory.com');
    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('hadron_server_info', {});

    expect(text).toMatch(/^server: https:\/\/gamma\.hadronmemory\.com$/m);
    expect(text).toMatch(new RegExp(`^version: ${HADRON_SERVER_VERSION}$`, 'm'));
  });

  it('does not leak DATABASE_URL or any credential-bearing value', async () => {
    // If a future contributor adds `db: ${process.env.DATABASE_URL}` or
    // similar to the response, this regression test catches it.
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://my-secret-user:my-secret-pass@my-host:5432/my-db',
    );

    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('hadron_server_info', {});

    expect(text).not.toContain('my-secret-pass');
    expect(text).not.toContain('my-secret-user');
    expect(text).not.toContain('postgresql://');
  });

  it('pins absence of tool-level auth gating (transport gates at /mcp; per-tool decoration is intentionally absent)', async () => {
    // NOT a claim that anonymous access works end-to-end — the transport
    // (handleMcpRequest at /mcp) rejects requests without an AuthContext
    // with 401 + RFC 9728 PRM. This test bypasses the transport on
    // purpose via createTestableMcpServer's _registeredTools shortcut,
    // and pins that the tool body itself has no auth decoration. A
    // future "require active App" check added here would silently break
    // the transcript-reader use case (inspecting a failed-auth session)
    // even after transport auth succeeds.
    const auth: AuthContext = {
      roles: [],
      clientId: 'anonymous',
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('hadron_server_info', {});

    expect(text).toMatch(/server:/);
    expect(text).toMatch(/version:/);
  });
});
