/**
 * #2314 — `resolveWorkerRef` scope contracts, pinned directly: `scope` narrows the worker row, `appScope`
 * narrows the App the worker URN resolves through. A foreign worker or App must read exactly like an absent one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolveWorkerRef } from './workerRef.js';
import { AmbiguousLegacyUrnError, WorkerNotFoundError } from './errors.js';

let a: { id: string };
let b: { id: string };
let wa: { id: string };
let wb: { id: string };

const ROOT = 'wref.example';
const urn = (app: string, slug: string) => `hrn:worker:${ROOT}:${app}:${slug}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Worker ref', urn: ROOT } });
  a = await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `${ROOT}:a` } });
  b = await db.app.create({ data: { organizationId: org.id, name: 'B', urn: `${ROOT}:b` } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Agent', urn: `${ROOT}:agent` } });
  const mk = (appId: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'Anne', slug: 'anne' } });
  wa = await mk(a.id);
  wb = await mk(b.id);
});

const rejection = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('expected a rejection');
};

describe('resolveWorkerRef — scope (#2314)', () => {
  it('applies `scope` on the ID path', async () => {
    expect(await resolveWorkerRef(db, wa.id, { scope: { appId: a.id } })).toEqual({ id: wa.id });
    await expect(resolveWorkerRef(db, wb.id, { scope: { appId: a.id } })).rejects.toBeInstanceOf(WorkerNotFoundError);
  });

  it('applies `scope` on the URN path when two Apps share a worker slug', async () => {
    expect(await resolveWorkerRef(db, urn('a', 'anne'), { scope: { appId: a.id } })).toEqual({ id: wa.id });
    expect(await resolveWorkerRef(db, urn('b', 'anne'), { scope: { appId: b.id } })).toEqual({ id: wb.id });
    await expect(resolveWorkerRef(db, urn('b', 'anne'), { scope: { appId: a.id } })).rejects.toBeInstanceOf(WorkerNotFoundError);
  });

  it('applies `appScope` alone: an excluded App reads as WorkerNotFound, identical to an absent slug', async () => {
    // No worker `scope` here, so only the App scope can stop this (mutant: appScope not forwarded to resolveAppRef).
    const hidden = await rejection(resolveWorkerRef(db, urn('a', 'anne'), { appScope: { id: b.id } }));
    expect(hidden).toBeInstanceOf(WorkerNotFoundError);
    expect(hidden).not.toBeInstanceOf(AmbiguousLegacyUrnError);
    const absent = await rejection(resolveWorkerRef(db, urn('b', 'nobody'), { appScope: { id: b.id } }));
    expect(absent).toBeInstanceOf(WorkerNotFoundError);
    expect(hidden.constructor).toBe(absent.constructor);
    expect(hidden.message.replace(urn('a', 'anne'), 'REF')).toBe(absent.message.replace(urn('b', 'nobody'), 'REF'));
    expect(await resolveWorkerRef(db, urn('a', 'anne'), { appScope: { id: a.id } })).toEqual({ id: wa.id });
  });

  it('heals a renamed App under scope, and stays ambiguous only when both claimants are admitted', async () => {
    const old = `${ROOT}:old`;
    for (const app of [a, b]) {
      await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: app.id, urn: old } });
    }
    expect(await resolveWorkerRef(db, urn('old', 'anne'), { appScope: { id: a.id } })).toEqual({ id: wa.id });
    await expect(resolveWorkerRef(db, urn('old', 'anne'), { appScope: { id: { in: [a.id, b.id] } } }))
      .rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolveWorkerRef(db, urn('old', 'anne'), { appScope: { id: generateId() } }))
      .rejects.toBeInstanceOf(WorkerNotFoundError);
  });

  it('is unchanged without options, and still resolves a retired worker', async () => {
    await db.worker.update({ where: { id: wa.id }, data: { retiredAt: new Date() } });
    expect(await resolveWorkerRef(db, wa.id)).toEqual({ id: wa.id });
    expect(await resolveWorkerRef(db, urn('a', 'anne'))).toEqual({ id: wa.id });
    expect(await resolveWorkerRef(db, urn('b', 'anne'), {})).toEqual({ id: wb.id });
  });
});
