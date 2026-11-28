/**
 * #5469: the Git-mirror WRITE capture is a trigger on `nodes`, so every fixture node a sweep or settle suite creates in a
 * mirrored memory now owes a PENDING WRITE row of its own. Those suites seed their obligation rows by hand (with exact
 * states, attempts and fences) and assert the whole table, so they switch the capture off for the file and say so here.
 * The capture itself, and its interplay with the sweep and the settle fence, is pinned in
 * src/integrations/github/nodeWriteMirror5469.test.ts. Triggers are per table and each worker has its own database
 * clone, so this reaches no other file's run; the afterAll puts them back for the next file on the same clone.
 */
import { afterAll, beforeAll } from 'vitest';
import { db } from '../integrations/db/client.js';

const TRIGGERS = ['git_mirror_node_write_insert', 'git_mirror_node_write_update'];

export function disableMirrorWriteCapture(): void {
  beforeAll(async () => { for (const t of TRIGGERS) await db.$executeRawUnsafe(`ALTER TABLE nodes DISABLE TRIGGER ${t}`); });
  afterAll(async () => { for (const t of TRIGGERS) await db.$executeRawUnsafe(`ALTER TABLE nodes ENABLE TRIGGER ${t}`); });
}
