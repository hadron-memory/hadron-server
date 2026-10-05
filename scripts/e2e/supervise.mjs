import { spawn } from 'node:child_process';
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 2000);
  deadline.unref();
  Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
    .then(() => process.exit(code));
}
for (const args of [['scripts/e2e/proxy.mjs'], ['--import', 'tsx', 'src/index.ts']]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', () => { if (!stopping) stop(1); });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
