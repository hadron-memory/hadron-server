/**
 * #4847: the operator's requeue script. A dry run lists and writes nothing; `--apply` needs a selector; only a CAPPED intent is
 * touched; the listing carries ids and handles, never a token; usage and a missing DATABASE_URL exit 2.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { main } from './requeue-chat-tool-teardown.js';

const url = () => process.env.DATABASE_URL!;
async function run(argv: string[], env: NodeJS.ProcessEnv = { DATABASE_URL: url() }) {
  const lines: string[] = [];
  const code = await main(argv, { env, log: (l) => lines.push(l) });
  return { code, lines };
}
const intent = (tool: string, state: string, attempts = 10) => db.chatToolTeardownIntent.create({
  data: { kind: 'telegram', provider: 'telegram', toolConnectionId: tool, state, attempts, lastAttemptAt: new Date(), cappedAt: state === 'CAPPED' ? new Date() : null } });

beforeEach(async () => { await cleanDb(db); });

describe('requeue-chat-tool-teardown', () => {
  it('a dry run lists only the capped intents (ids and handles) and writes nothing', async () => {
    const capped = await intent('t-capped', 'CAPPED');
    await intent('t-pending', 'PENDING', 3); await intent('t-done', 'CONFIRMED', 2);
    const { code, lines } = await run([]);
    expect(code).toBe(0);
    expect(lines.filter((l) => l.includes(' capped id='))).toHaveLength(1);
    expect(lines.join('\n')).toContain(`id=${capped.id}`);
    expect(lines.join('\n')).toContain('tool_connection_id=t-capped');
    expect(lines.join('\n')).not.toMatch(/token|secret/i);
    expect(lines.at(-1)).toContain('dry_run capped=1');
    expect(await db.chatToolTeardownIntent.count({ where: { state: 'CAPPED' } })).toBe(1);
  });

  it('--id --apply requeues that one capped intent from a clean count and no other', async () => {
    const a = await intent('t-a', 'CAPPED'); const b = await intent('t-b', 'CAPPED');
    const { code, lines } = await run(['--id', a.id, '--apply']);
    expect(code).toBe(0);
    expect(lines.at(-1)).toContain('requeued=1');
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ state: 'PENDING', attempts: 0, lastAttemptAt: null, cappedAt: null });
    expect((await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id: b.id } })).state).toBe('CAPPED');
  });

  it('--all --apply requeues every capped intent and never a pending or confirmed one', async () => {
    await intent('t-1', 'CAPPED'); await intent('t-2', 'CAPPED');
    const pending = await intent('t-3', 'PENDING', 4); const done = await intent('t-4', 'CONFIRMED', 1);
    expect((await run(['--all', '--apply'])).lines.at(-1)).toContain('requeued=2');
    expect(await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ state: 'PENDING', attempts: 4 });
    expect((await db.chatToolTeardownIntent.findUniqueOrThrow({ where: { id: done.id } })).state).toBe('CONFIRMED');
  });

  it('--apply without a selector, an unknown flag and a missing DATABASE_URL are usage errors that write nothing', async () => {
    await intent('t-x', 'CAPPED');
    expect((await run(['--apply'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--id', '--apply'])).code).toBe(2);
    expect((await run([], {})).code).toBe(2);
    expect(await db.chatToolTeardownIntent.count({ where: { state: 'CAPPED' } })).toBe(1);
  });
});
