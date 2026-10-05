import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [stateDir, port, address] = process.argv.slice(2);
const script = fileURLToPath(new URL('./host-proxy.mjs', import.meta.url));
const log = openSync(`${stateDir}/proxy.log`, 'a', 0o600);
const child = spawn('node', [script, port, address], { detached: true, stdio: ['ignore', log, log] });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('spawn', () => {
  // import.meta.url resolves the checkout's symlinks: record this exact argv.
  writeFileSync(`${stateDir}/proxy-script`, `${script}\n`, { mode: 0o600 });
  writeFileSync(`${stateDir}/proxy.pid`, `${child.pid}\n`, { mode: 0o600 });
  closeSync(log);
  child.unref();
});
