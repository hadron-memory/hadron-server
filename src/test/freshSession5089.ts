/**
 * #5089: run a body on a FRESH connection inside a transaction that is always rolled back. The shadow-table pins need this:
 * plpgsql caches a function's plan per session, so a pooled connection that already ran the guard would keep the plan that
 * names the real table and the pin could not fail on an unqualified guard. A fresh session plans under the shadow.
 */
import { Client } from 'pg';

export async function inFreshRolledBackSession<T>(body: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    try { return await body(c); } finally { await c.query('ROLLBACK'); }
  } finally {
    await c.end();
  }
}

/** The shadow: an empty session-local table named like a public one. */
export const shadowTable = (c: Client, table: string) => c.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
