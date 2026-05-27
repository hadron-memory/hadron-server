/**
 * PR-C-diagnostics — #187 / #190 deployment-info surface.
 *
 * Pins:
 *   - getDeploymentInfo() reads BASE_URL and falls back to localhost:PORT
 *     (mirrors the pattern in src/auth/github.ts and src/auth/email.ts).
 *   - HADRON_SERVER_VERSION is exposed unchanged through both surfaces
 *     (no copy in the McpServer constructor — verified by grep so the
 *     hardcoded literal can't drift back in).
 *   - h-set-active-memory's success message includes the bound server
 *     URL + version inline.
 *   - h-server-info returns server + version, requires no auth context
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

describe('getDeploymentInfo (#187 / #190 diagnostics)', () => {
  const savedBaseUrl = process.env.BASE_URL;
  const savedPort = process.env.PORT;

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = savedBaseUrl;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it('returns BASE_URL when set', () => {
    process.env.BASE_URL = 'https://alpha.hadronmemory.com';
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('https://alpha.hadronmemory.com');
    expect(info.version).toBe(HADRON_SERVER_VERSION);
  });

  it('falls back to http://localhost:${PORT} when BASE_URL is unset (auth/* convention)', () => {
    delete process.env.BASE_URL;
    process.env.PORT = '4321';
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:4321');
  });

  it('falls back to http://localhost:4000 when both BASE_URL and PORT are unset', () => {
    delete process.env.BASE_URL;
    delete process.env.PORT;
    const info = getDeploymentInfo();
    expect(info.baseUrl).toBe('http://localhost:4000');
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

describe('h-set-active-memory — includes deployment info in success message (#187 / #190)', () => {
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

  it('success message names the bound server URL and version', async () => {
    process.env.BASE_URL = 'https://beta.hadronmemory.com';
    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('h-set-active-memory', {
      memoryUrn: memory.urn,
    });

    expect(text).toMatch(/Active memory set to:/);
    expect(text).toMatch(/server: https:\/\/beta\.hadronmemory\.com/);
    expect(text).toMatch(new RegExp(`version: ${HADRON_SERVER_VERSION}`));

    delete process.env.BASE_URL;
  });
});

describe('h-server-info — returns server identity (#187 / #190)', () => {
  let admin: { id: string };

  beforeEach(async () => {
    await cleanDb(db);
    admin = await db.user.create({
      data: { githubId: 9802, githubUsername: 'si-admin', roles: ['ADMIN'] },
    });
  });

  it('returns server URL and version with no other side data', async () => {
    process.env.BASE_URL = 'https://gamma.hadronmemory.com';
    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('h-server-info', {});

    expect(text).toMatch(/^server: https:\/\/gamma\.hadronmemory\.com$/m);
    expect(text).toMatch(new RegExp(`^version: ${HADRON_SERVER_VERSION}$`, 'm'));

    delete process.env.BASE_URL;
  });

  it('does not leak DATABASE_URL or any credential-bearing value', async () => {
    // If a future contributor adds `db: ${process.env.DATABASE_URL}` or
    // similar to the response, this regression test catches it.
    process.env.DATABASE_URL =
      'postgresql://my-secret-user:my-secret-pass@my-host:5432/my-db';

    const auth: AuthContext = {
      userId: admin.id,
      roles: ['ADMIN'],
      clientId: `user:${admin.id}`,
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('h-server-info', {});

    expect(text).not.toContain('my-secret-pass');
    expect(text).not.toContain('my-secret-user');
    expect(text).not.toContain('postgresql://');
  });

  it('works for an unauthenticated-shape caller (server identity is not tenant data)', async () => {
    // h-server-info should be answerable even when auth is minimal —
    // it returns server identity, not per-tenant data. We pin this
    // explicitly so a future "require active App" decoration doesn't
    // silently break the use case (transcript reader inspecting a
    // failed-auth session).
    const auth: AuthContext = {
      roles: [],
      clientId: 'anonymous',
    };
    const srv = createTestableMcpServer(auth);
    const text = await srv.callToolText('h-server-info', {});

    expect(text).toMatch(/server:/);
    expect(text).toMatch(/version:/);
  });
});
