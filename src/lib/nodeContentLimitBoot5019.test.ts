/** #5019 (Billing A11): a malformed NODE_CONTENT_MAX_BYTES refuses boot without echoing the value. Imports none of the new modules, so it is red on main because main boots. */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const MARKER = 'x7Qmarker';

describe('#5019 boot', () => {
  const boot = (value: string) => new Promise<{ code: number | null; out: string }>((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { createServer } from ${JSON.stringify(resolve('src/server.ts'))};
      await createServer();
      console.log('BOOTED');
      process.exit(0);
    `], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', NODE_CONTENT_MAX_BYTES: value },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`boot timed out: ${out.slice(-500)}`)); }, 60_000);
    child.once('error', (e) => { clearTimeout(timer); fail(e); });
    child.once('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });

  it('a malformed value refuses boot without echoing it', async () => {
    const { code, out } = await boot(MARKER);
    expect(out).not.toContain('BOOTED');
    expect(code).not.toBe(0);
    expect(out).toContain('NODE_CONTENT_MAX_BYTES must be');
    expect(out).not.toContain(MARKER);
  }, 70_000);

  it('a valid value boots', async () => {
    const { code, out } = await boot('1000');
    expect(out).toContain('BOOTED');
    expect(code).toBe(0);
  }, 70_000);
});
