/**
 * #4111 test support: a SOURCE cluster with the full Hadron schema and an agent_team_events history keyed by that
 * cluster's xids, and a TARGET cluster provisioned with the operator prerequisites P1/P2 (restore_admin, owner and
 * serve roles, a superuser-made template holding `vector`). Throwaway clusters only.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import type { PrivateCluster } from './privateCluster.js';

export const PASSWORD = 'restore-4111-test';
export const ROLES = { admin: 'restore_admin', owner: 'hadron_owner', serve: 'hadron_app', other: 'hadron_other' } as const;
export const TEMPLATE = 'hadron_tpl';

export async function sql<T = any>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** The full schema into `db` on the cluster (db push + post-push.sql), as the superuser. */
export async function buildSchema(cluster: PrivateCluster, db: string): Promise<void> {
  await sql(cluster.url(), `CREATE DATABASE ${db}`);
  await sql(cluster.url(db), 'CREATE EXTENSION IF NOT EXISTS vector');
  const env = { ...process.env, DATABASE_URL: cluster.url(db) };
  execFileSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate', '--accept-data-loss'], { env, stdio: 'pipe' });
  execFileSync('psql', [cluster.url(db), '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'prisma/post-push.sql'], { stdio: 'pipe' });
  await sql(cluster.url(db), 'CREATE TABLE IF NOT EXISTS _prisma_migrations (id varchar(36) PRIMARY KEY)');
}

/** P1/P2 on a target cluster. */
export async function provisionTarget(cluster: PrivateCluster): Promise<void> {
  const su = cluster.url();
  await sql(su, `CREATE ROLE ${ROLES.owner} LOGIN PASSWORD '${PASSWORD}'`);
  await sql(su, `CREATE ROLE ${ROLES.serve} LOGIN PASSWORD '${PASSWORD}'`);
  await sql(su, `CREATE ROLE ${ROLES.other} LOGIN PASSWORD '${PASSWORD}'`);
  await sql(su, `CREATE ROLE ${ROLES.admin} LOGIN CREATEDB PASSWORD '${PASSWORD}'`);
  await sql(su, `GRANT ${ROLES.owner} TO ${ROLES.admin} WITH INHERIT FALSE, SET TRUE`);
  await sql(su, `CREATE DATABASE ${TEMPLATE}`);
  await sql(cluster.url(TEMPLATE), 'CREATE EXTENSION vector');
  await sql(su, `ALTER DATABASE ${TEMPLATE} IS_TEMPLATE true`);
}

export const adminUrl = (cluster: PrivateCluster, db = 'postgres') => cluster.url(db, ROLES.admin, PASSWORD);

/** pg_dump -Fc of a database into `file`. */
export function dump(cluster: PrivateCluster, db: string, file: string): void {
  execFileSync(join(cluster.bin, 'pg_dump'), ['-Fc', '-f', file, cluster.url(db)], { stdio: 'pipe' });
}

let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36).padStart(4, '0')}`;

/** An org, an App and a task; returns their ids. */
export async function seedApp(url: string, name: string): Promise<{ appId: string; taskId: string }> {
  const org = nid('org');
  const appId = nid('app');
  const taskId = nid('tsk');
  await sql(url, `INSERT INTO organizations (id, name, urn, updated_at) VALUES ($1, $2, $3, now())`, [org, name, `${org}.test`]);
  await sql(url, `INSERT INTO apps (id, name, urn, organization_id) VALUES ($1, $2, $3, $4)`, [appId, name, `${org}.test:team`, org]);
  const user = nid('usr');
  await sql(url, `INSERT INTO users (id, handle, updated_at) VALUES ($1, $1, now())`, [user]);
  await sql(
    url,
    `INSERT INTO agent_tasks (id, app_id, handle, task_number, title, owner_user_id) VALUES ($1, $2, 'AT1', 1, 'T', $3)`,
    [taskId, appId, user],
  );
  return { appId, taskId };
}

/** One event in its own transaction (key = that transaction's xid), stamped `offset` from now. */
export async function event(url: string, appId: string, taskId: string, offset = '0 seconds'): Promise<string> {
  const id = nid('evt');
  await sql(
    url,
    `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
     VALUES ($1, $2, 'task.assigned', $3, '{"type":"task.assigned"}', (clock_timestamp() AT TIME ZONE 'UTC') + $4::interval)`,
    [id, appId, taskId, offset],
  );
  return id;
}

/** The serving order `S` as (id, key) rows. */
export const servingOrder = (url: string) =>
  sql<{ id: string; k: string }>(url, `SELECT id, tx_id::text AS k FROM agent_team_events ORDER BY tx_id, created_at, id`);
