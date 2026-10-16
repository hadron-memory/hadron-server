/** #992 landing prerequisite. Explicit connection, read-only transaction, no repair. */
import { Client } from 'pg';
import { teamChatSeqPreflightSql, teamChatSeqSummarySql } from '../src/lib/teamChatSeqPreflight.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required for the read-only team-chat sequence preflight.\n');
  process.exitCode = 2;
} else {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await client.query(teamChatSeqPreflightSql);
    const summary = (await client.query(teamChatSeqSummarySql)).rows[0];
    await client.query('COMMIT');
    process.stdout.write(JSON.stringify({ ...summary, collisionGroups: result.rows.length, collisions: result.rows }, null, 2) + '\n');
    if (result.rows.length > 0) process.exitCode = 5;
  } catch {
    // Neither the connection URL nor raw DB diagnostics are an operator report.
    process.stderr.write('TEAM_CHAT_SEQ_PREFLIGHT_FAILED: no successful census; inspect database availability and schema, then retry.\n');
    process.exitCode = 1;
  } finally { await client.end().catch(() => {}); }
}
