/**
 * #1323 — the SQL fingerprint and the application's tracked-field list must
 * name the SAME node columns.
 *
 * `hadron_node_revision_state_hash(nodes)` (migration + post-push.sql) hashes a
 * hand-written column list; `TRACKED_NODE_FIELDS` decides, in TypeScript, what
 * a write "changed". If they drift, drift detection misfires silently: a field
 * only TypeScript tracks never trips a reconcile, and a field only SQL hashes
 * turns every sanctioned write of it into a phantom server revision. And since
 * PostgreSQL records no dependency on columns named inside a SQL function
 * body, renaming or dropping one of them succeeds in a migration and then
 * fails EVERY node write through the trigger. This test reads the LIVE
 * function definition, so both mistakes red here first (Eli, PR #1339 review).
 */
import { describe, it, expect } from 'vitest';

import { db } from '../integrations/db/client.js';
import { TRACKED_NODE_FIELDS } from './nodeRevisionSnapshot.js';

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('#1323 — revision fingerprint columns agree with TRACKED_NODE_FIELDS', () => {
  it('the live SQL function hashes exactly the tracked fields', async () => {
    const [row] = await db.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_functiondef('hadron_node_revision_state_hash(nodes)'::regprocedure) AS def
    `;
    const hashed = [...row!.def.matchAll(/node_row\."([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(hashed.length).toBeGreaterThan(10); // the regex actually read the body
    expect(hashed).toEqual([...TRACKED_NODE_FIELDS].map(snake).sort());
  });

  it('every hashed column still exists on nodes', async () => {
    const cols = await db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'nodes'
    `;
    const present = new Set(cols.map((c) => c.column_name));
    const missing = [...TRACKED_NODE_FIELDS].map(snake).filter((c) => !present.has(c));
    expect(missing).toEqual([]);
  });
});
