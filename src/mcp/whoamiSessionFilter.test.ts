/**
 * #2314 — `whoamiSessionFilter` pinned directly, with no MCP server in front. The end-to-end whoami tests cannot
 * see the resolvers' own scoping fail, because the final session query narrows rows regardless.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { boundSessionPrivacyFilter } from '../lib/auth/sessionPrivacy.js';
import { whoamiSessionFilter } from './whoamiSessionFilter.js';

const ROOT = 'wsf.example';

let user: { id: string };
let outsider: { id: string };
let a: { id: string; urn: string };
let b: { id: string; urn: string };
let foreign: { id: string; urn: string };
let wa: { id: string };
let wb: { id: string };
let wForeign: { id: string };
let sa: { id: string };
let sb: { id: string };
let agentId: string;

const tx = () => db as unknown as Prisma.TransactionClient;
/** The minimal authorized shape, plus the caller's real one (server.ts's `authorizedWhere`) below. */
const authorized = (): Prisma.SessionWhereInput => ({ userId: user.id });
const realShape = (): Prisma.SessionWhereInput => ({
  AND: [{ userId: user.id }, boundSessionPrivacyFilter({ userId: user.id })],
  deletedAt: null,
  endedAt: null,
});

async function idsFor(where: Prisma.SessionWhereInput) {
  return (await db.session.findMany({ where, select: { id: true } })).map(r => r.id).sort();
}

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: 'wsf-user', roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), handle: 'wsf-out', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'WSF', urn: ROOT } });
  const mkApp = (slug: string) => db.app.create({ data: { organizationId: org.id, name: slug, urn: `${ROOT}:${slug}` } });
  a = await mkApp('a');
  b = await mkApp('b');
  foreign = await mkApp('foreign');
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Agent', urn: `${ROOT}:agent` } });
  agentId = agent.id;
  const mkWorker = (appId: string, name: string, slug: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug } });
  wa = await mkWorker(a.id, 'Anne', 'anne');
  wb = await mkWorker(b.id, 'Anne', 'anne');
  wForeign = await mkWorker(foreign.id, 'Frank', 'frank');
  const mkSession = (userId: string, appId: string, workerId: string) =>
    db.session.create({ data: { id: generateId(), userId, appId, workerId, startedAt: new Date() }, select: { id: true } });
  sa = await mkSession(user.id, a.id, wa.id);
  sb = await mkSession(user.id, b.id, wb.id);
  await mkSession(outsider.id, foreign.id, wForeign.id);
});

describe('whoamiSessionFilter — matched selections (#2314)', () => {
  it.each([
    ['no filter', () => ({}), () => [sa.id, sb.id]],
    ['app id', () => ({ app: b.id }), () => [sb.id]],
    ['qualified app URN', () => ({ app: `hrn:app:${b.urn}` }), () => [sb.id]],
    ['worker id', () => ({ workerRef: wb.id }), () => [sb.id]],
    ['worker URN', () => ({ workerRef: `hrn:worker:${ROOT}:b:anne` }), () => [sb.id]],
    ['app + worker name', () => ({ app: a.id, workerRef: 'Anne' }), () => [sa.id]],
  ])('%s', async (_n, filters, expected) => {
    for (const auth of [authorized(), realShape()]) {
      const sel = await whoamiSessionFilter(tx(), auth, filters());
      expect(sel.kind).toBe('matched');
      if (sel.kind === 'matched') expect(await idsFor(sel.where)).toEqual([...expected()].sort());
    }
  });

  it('a worker filter after an app filter uses the app-narrowed set', async () => {
    const sel = await whoamiSessionFilter(tx(), authorized(), { app: a.id, workerRef: wb.id });
    expect(sel).toEqual({ kind: 'missing' });
  });
});

describe('whoamiSessionFilter — concealment (#2314)', () => {
  it('reports foreign, absent and malformed refs identically as missing', async () => {
    const cases: Array<{ app?: string; workerRef?: string }> = [
      { app: foreign.id }, { app: generateId() }, { app: 'not-qualified' }, { app: 42 as unknown as string },
      { workerRef: wForeign.id }, { workerRef: generateId() }, { workerRef: '   ' }, { workerRef: 7 as unknown as string },
      { workerRef: `hrn:worker:${ROOT}:foreign:frank` },
    ];
    for (const filters of cases) {
      expect(await whoamiSessionFilter(tx(), authorized(), filters), JSON.stringify(filters)).toEqual({ kind: 'missing' });
    }
  });

  it('reports an ambiguous accessible name or slug as ambiguous', async () => {
    expect(await whoamiSessionFilter(tx(), authorized(), { workerRef: 'anne' })).toEqual({ kind: 'ambiguous' });
  });

  it('reports an alias held by two accessible Apps as ambiguous, and by one accessible App as matched', async () => {
    const old = `${ROOT}:old`;
    for (const app of [a, b, foreign]) {
      await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: app.id, urn: old } });
    }
    // a and b are both accessible, so the alias is ambiguous; `foreign` (the outsider's) is not part of it.
    expect(await whoamiSessionFilter(tx(), authorized(), { app: `hrn:app:${old}` })).toEqual({ kind: 'ambiguous' });
    // With b no longer accessible, the inaccessible claimants (b, foreign) must not keep it ambiguous.
    await db.session.deleteMany({ where: { id: sb.id } });
    const sel = await whoamiSessionFilter(tx(), authorized(), { app: `hrn:app:${old}` });
    expect(sel.kind).toBe('matched');
    if (sel.kind === 'matched') expect(await idsFor(sel.where)).toEqual([sa.id]);
  });

  it('an inaccessible name claimant does not turn an accessible slug into ambiguity', async () => {
    const visible = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: a.id, agentId, name: 'Visible', slug: 'needle' } });
    const hidden = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: foreign.id, agentId, name: 'Needle', slug: 'hidden' } });
    const mine = await db.session.create({ data: { id: generateId(), userId: user.id, appId: a.id, workerId: visible.id } });
    await db.session.create({ data: { id: generateId(), userId: outsider.id, appId: foreign.id, workerId: hidden.id } });
    const sel = await whoamiSessionFilter(tx(), authorized(), { workerRef: 'needle' });
    expect(sel.kind).toBe('matched');
    if (sel.kind === 'matched') expect(await idsFor(sel.where)).toEqual([mine.id]);
  });
});
