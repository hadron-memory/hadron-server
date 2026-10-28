/** #1162: deployment parity and the closed, typed writer-fence inventory. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { workerReferenceError } from './workerReferenceError.js';

const source = readFileSync(new URL('../../prisma/worker-reference-invariants.sql', import.meta.url), 'utf8');
describe('#1162 reference fence deployment', () => {
  it('ships byte-identical migration and post-push guards', () => {
    // The guard file is its migrations, in order: the #1162 fence, then each later table that joined the inventory.
    const migrations = ['20261016050000_worker_reference_fence', '20261019040100_worker_wake_acks_fence', '20261020030200_stop_signal_worker_fence', '20261022000100_compiled_prompt_worker_fence', '20261024100300_context_reset_worker_fence', '20261024120100_ticker_generated_worker_fence']
      .map((m) => readFileSync(new URL(`../../prisma/migrations/${m}/migration.sql`, import.meta.url), 'utf8'));
    expect(migrations.join('')).toBe(source);
    expect(readFileSync(new URL('../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir worker-reference-invariants.sql');
  });

  it('enumerates every typed scalar Worker/session column in the current schema', () => {
    for (const model of Prisma.dmmf.datamodel.models) {
      const table = model.dbName ?? model.name;
      const trigger = source.split(`CREATE TRIGGER worker_reference_fence_1162 AFTER INSERT OR UPDATE ON "${table}"`).at(-1)?.split(';')[0];
      for (const field of model.fields.filter((f) => f.kind === 'scalar' && /(?:worker|session)Id$/i.test(f.name))) {
        expect(trigger, `${model.name}.${field.name} missing from closed fence inventory`).toContain(`'${/workerId$/i.test(field.name) ? 'w' : 's'}:$.${field.dbName ?? field.name}'`);
      }
    }
  });

  it('only maps the typed guard marker, never arbitrary database failures', () => {
    const missing = 'missing-worker';
    const typed = new Prisma.PrismaClientUnknownRequestError(`PostgresError { code: "P1162", message: "WORKER_REFERENCE_NOT_FOUND ref=${Buffer.from(missing).toString('hex')} kind=worker writer=nodes" }`, { clientVersion: 'test' });
    expect(workerReferenceError(typed)?.extensions).toMatchObject({ code: 'WORKER_REFERENCE_NOT_FOUND', workerRef: missing, writer: 'nodes' });
    expect(workerReferenceError(new Prisma.PrismaClientUnknownRequestError('some other failure', { clientVersion: 'test' }))).toBeNull();
    expect(workerReferenceError(new Error(typed.message))).toBeNull();
    expect(workerReferenceError(new Prisma.PrismaClientUnknownRequestError(
      'Invocation input: WORKER_REFERENCE_NOT_FOUND ref=616263 kind=worker writer=nodes', { clientVersion: 'test' },
    ))).toBeNull();
  });
});
