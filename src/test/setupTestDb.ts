/**
 * `pnpm db:test-setup` (#1922): rebuild the serial-mode test database from
 * EMPTY for this checkout's schema and stamp it. Target: TEST_DATABASE_URL, or
 * the default `hadron_test`. Parallel mode does not need this; it builds a
 * template per schema on its own (src/test/schemaTemplate.ts).
 */
import { rebuildBaseTestDb } from './schemaTemplate.js';
import { baseTestDbUrl, baseDbName } from './dbWorkers.js';

const fingerprint = await rebuildBaseTestDb();
console.log(`Rebuilt ${baseDbName(baseTestDbUrl())} from empty for schema ${fingerprint}.`);
