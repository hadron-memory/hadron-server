/**
 * #445: child-process fixture for sweepLock.test.ts. Holds the sweep lock `argv[2]`
 * in THIS process (a second OS process, not a second connection in the test's
 * own) until the latch file `argv[3]` exists, announcing `held` on stdout.
 */
import { existsSync } from 'node:fs';
import { withSweepLock } from './sweepLock.js';

const [name, latch] = process.argv.slice(2);
const result = await withSweepLock(name, async () => {
  console.log('held');
  while (!existsSync(latch)) await new Promise((r) => setTimeout(r, 25));
});
console.log(result.ran ? 'released' : 'skipped');
