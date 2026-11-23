/**
 * #3021 part 1 (e2e half): the disposable stack's readiness waits are checked against the REAL /ready handler, not a
 * fake (Joshua's BLIND P2-1 on #4755). The e2e scripts assume two things about GET /ready (cor:api:270:01, #2998):
 *  1. it is 200 only when ready, so the compose healthcheck (`r.ok`) never passes while the first startup is pending,
 *     has failed, or shutdown has begun, although /health is 200 in all of those states;
 *  2. its ready body is byte-for-byte the literal that scripts/e2e/stack.sh check_published compares.
 * Both are pinned here by running the compose healthcheck's own `node -e` program, and reading stack.sh's literal,
 * against `mountHealthRoutes` itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { db } from '../integrations/db/client.js';
import { mountHealthRoutes, type ReadinessSource, type StartupState } from './health.js';

const repo = new URL('../../', import.meta.url);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); });

async function serve(readiness: ReadinessSource): Promise<number> {
  const app = express();
  mountHealthRoutes(app, db, { readiness });
  const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}
const source = (state: StartupState, stopping = false): ReadinessSource => ({ startup: () => state, stopping: () => stopping });

/** The app service's healthcheck program from scripts/e2e/compose.yaml, retargeted from the container port. */
function healthcheckProgram(port: number): string {
  const compose = readFileSync(new URL('scripts/e2e/compose.yaml', repo), 'utf8');
  const m = compose.match(/\n {4}healthcheck:\n {6}test: \[CMD, node, -e, "([^"]+)"\]/);
  if (!m) throw new Error('compose.yaml: app healthcheck program not found');
  expect(m[1]).toContain('http://127.0.0.1:4100/ready');
  return m[1].replace('http://127.0.0.1:4100/', `http://127.0.0.1:${port}/`);
}
const exitOf = (program: string) => new Promise<number | null>((resolve, reject) => {
  spawn(process.execPath, ['-e', program], { stdio: 'ignore' }).on('error', reject).on('close', resolve);
});

/** The literal stack.sh's check_published requires of the published /ready body. */
function stackShReadyLiteral(): string {
  const sh = readFileSync(new URL('scripts/e2e/stack.sh', repo), 'utf8');
  // Scoped to check_published's own body, so another comparison elsewhere in the file can't be matched instead.
  const fn = sh.match(/\ncheck_published\(\) \{\n([\s\S]*?)\n\}\n/);
  if (!fn) throw new Error('stack.sh: check_published not found');
  expect(fn[1]).toMatch(/curl --fail [^\n]*"\$base\/ready"\)/);
  const m = fn[1].match(/\[\[ "\$body" == '([^']+)' \]\]/);
  if (!m) throw new Error('stack.sh: check_published body literal not found');
  return m[1];
}

describe('#3021 the e2e readiness waits against the real /ready handler', () => {
  it('ready: the compose healthcheck passes and the body is exactly stack.sh\'s literal', async () => {
    const port = await serve(source('settled'));
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(stackShReadyLiteral());
    expect(await exitOf(healthcheckProgram(port))).toBe(0);
  });

  it.each([
    ['starting', source('starting')],
    ['startup_failed', source('startup_failed')],
    ['stopping', source('settled', true)],
  ] as const)('%s: /health is 200 but the compose healthcheck refuses (/ready 503)', async (error, readiness) => {
    const port = await serve(readiness);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error });
    expect(await exitOf(healthcheckProgram(port))).toBe(1);
  });
});
