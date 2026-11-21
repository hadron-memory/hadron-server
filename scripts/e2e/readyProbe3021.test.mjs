// #3021 part 1 (the e2e half): the disposable stack's readiness waits ask GET /ready, not GET /health.
// /health is liveness and stays 200 while the first startup has failed; /ready answers 503 `startup_failed`
// (cor:api:270:01). So a stack whose first startup failed must never count as up. Both waits are pinned
// against a fake server that is alive (/health 200) but not ready (/ready 503), and against a ready one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const script = here('./stack.sh');

/** A fake stack: /health is always alive; /ready is 200 { ok: true } only when `ready`. */
async function fakeStack(ready) {
  const server = createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/ready') return ready ? send(200, { ok: true }) : send(503, { ok: false, error: 'startup_failed' });
    if (req.url?.startsWith('/auth/dev/login')) { res.writeHead(302, { location: '/' }); return res.end(); }
    return send(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

/** Run a command to completion without blocking the event loop (the fake server must keep answering). */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** The compose healthcheck's own `node -e` program, aimed at the fake server instead of the container port. */
function healthcheckProgram(port) {
  const compose = readFileSync(here('./compose.yaml'), 'utf8');
  const m = compose.match(/healthcheck:\s*\n\s*test: \[CMD, node, -e, "([^"]+)"\]/);
  assert(m, 'the app healthcheck runs a node -e program');
  assert(m[1].includes('http://127.0.0.1:4100/'), 'the healthcheck targets the container port');
  return m[1].replace('http://127.0.0.1:4100/', `http://127.0.0.1:${port}/`);
}

for (const ready of [false, true]) {
  test(`compose healthcheck: ${ready ? 'a ready server is healthy' : 'alive but not ready (startup_failed) is NOT healthy'}`, async (t) => {
    const { server, port } = await fakeStack(ready);
    t.after(() => server.close());
    const probe = await run(process.execPath, ['-e', healthcheckProgram(port)], {});
    assert.equal(probe.status, ready ? 0 : 1);
  });

  test(`stack.sh check: ${ready ? 'a ready published stack passes' : 'alive but not ready (startup_failed) refuses'}`, async (t) => {
    const { server, port } = await fakeStack(ready);
    const root = mkdtempSync(join(tmpdir(), 'hadron-e2e-ready-'));
    t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
    const bin = join(root, 'bin'); mkdirSync(bin);
    // The steps after the published check go through Docker; they are stubbed to succeed so only that check decides.
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const dir = join(root, 'hadron-e2e', 'hadron-e2e-ready3021');
    mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries({ backend: 'docker', 'api-port': String(port), 'portal-port': '18599' })) {
      writeFileSync(join(dir, name), `${value}\n`);
    }
    const result = await run('bash', [script, 'check', 'ready3021'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: root, E2E_BACKEND: 'docker' },
    });
    if (ready) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Published readiness and dev-login handoff PASS/);
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /PASS/);
    }
  });
}
