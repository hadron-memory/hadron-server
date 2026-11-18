/**
 * #3709 (Grants S2a-urn; cor:urn:010:01's Grant row, rulings:0255 item 9; cor:acl:140:05's
 * read gate): a grant is addressable by its computed URN `hrn:grant:<root>:<app-slug>:<grant-id>`
 * on every read surface — `grant(ref:)`, `Grant.urn` and the `resolveUrn` arm — under the SAME
 * gate as the id read (a bound worker session in its own App, the row scope of
 * src/lib/grants/read.ts). The URN is computed, never stored, and keeps resolving through the
 * App's rename alias map, exactly as a worker URN does (cor:urn:030).
 *
 * Concealment is the other half: a grant the caller may not read answers exactly as a missing
 * one — null from `grant(ref:)`, null from `resolveUrn` — never an error, never a different
 * answer for a row that exists than for one that does not (acceptance 1; cor:api:140:02).
 * A malformed or wrong-type URN is the one typed input refusal on the surface (acceptance 3;
 * cor:api:140:01: URN_NOT_QUALIFIED).
 *
 * Pins go over real GraphQL POSTs on the #3789 harness: the reader gate keys off the session
 * row, and the wire shape (extensions.code) is what the boundary delivers.
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { composeGrantUrnV2 } from '../../../lib/urn.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let http: Server;
let base: string;
beforeAll(async () => {
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); await cleanDb(db); await dropTestActions(); });

let w: World;
let rawKey: string;
let sessionId: string;
/** The org's urn (its bare `<root>` form, e.g. `g-ab12cd34.test`) and the App's slug. */
let orgUrn: string;
const APP_SLUG = 'app';

async function keyFor(userId: string): Promise<string> {
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  return k;
}
async function post(key: string, session: string | null, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(session ? { 'x-hadron-session': session } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

const ONE = 'query($r:ID!){grant(ref:$r){id allows}}';
const ONE_WITH_URN = 'query($r:ID!){grant(ref:$r){id urn}}';
const RESOLVE = 'query($u:String!){resolveUrn(urn:$u){kind id organizationId}}';
const asWorker = (q: string, v: Record<string, unknown> = {}) => post(rawKey, sessionId, q, v);

const activated = { activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 'test' };
/** A live grant held by the reader's worker in the reader's App; returns {id, urn}. */
async function heldGrant(over: Record<string, unknown> = {}): Promise<{ id: string; urn: string }> {
  const id = await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, ...activated, ...over } as never);
  return { id, urn: composeGrantUrnV2(orgUrn, APP_SLUG, id) };
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
  orgUrn = org.urn;
  for (const userId of [w.userId, w.user2Id]) await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'CONTRIBUTOR' } });
  await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: w.userId } });
  sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: w.userId, workerId: w.workerId, agentId: w.agentId } })).id;
  rawKey = await keyFor(w.userId);
});

describe('#3709 — grant(ref:) accepts the computed URN under the id read gate', () => {
  it('resolves a grant the reader holds by hrn:grant, exactly as by bare id', async () => {
    const g = await heldGrant();
    const byUrn = await asWorker(ONE, { r: g.urn });
    expect(byUrn.errors, JSON.stringify(byUrn.errors)).toBeUndefined();
    expect(byUrn.data.grant?.id).toBe(g.id);

    const byId = await asWorker(ONE, { r: g.id });
    expect(byId.data.grant?.id).toBe(g.id);
  });

  it('the emitted Grant.urn matches composeGrantUrnV2 byte for byte (acceptance 4)', async () => {
    const g = await heldGrant();
    const page = await asWorker('query{grants(limit:50){items{id urn}}}', {});
    expect(page.errors, JSON.stringify(page.errors)).toBeUndefined();
    const mine = (page.data.grants.items as Array<{ id: string; urn: string | null }>).find((i) => i.id === g.id);
    // The corpus fixture form: hrn:grant:<root>:<app-slug>:<grant-id> — single colons,
    // lower-case atoms, the App slug as the container, the grant id as the leaf.
    expect(mine?.urn).toBe(g.urn);
    expect(mine?.urn).toMatch(/^hrn:grant:[a-z0-9.-]+:app:[0-9a-f]{32}$/);
  });

  it('resolveUrn answers kind "grant" for a readable grant, null for an unreadable one', async () => {
    const g = await heldGrant();
    const ok = await asWorker(RESOLVE, { u: g.urn });
    expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
    expect(ok.data.resolveUrn).toMatchObject({ kind: 'grant', id: g.id });

    // A grant of the OTHER App: the reader's row scope never sees it, so the URN
    // names nothing — the same null as for a grant that does not exist. Null AND
    // error-free: a typed GRANT_NOT_FOUND on the wire would be an existence oracle.
    const otherId = await insertGrantUnguarded(w, { app_id: w.app2Id, user_id: null, worker_id: w.workerId, ...activated } as never);
    const foreign = await asWorker(RESOLVE, { u: composeGrantUrnV2(orgUrn, 'app2', otherId) });
    expect(foreign.errors, JSON.stringify(foreign.errors)).toBeUndefined();
    expect(foreign.data.resolveUrn).toBeNull();

    const missing = await asWorker(RESOLVE, { u: composeGrantUrnV2(orgUrn, APP_SLUG, generateId()) });
    expect(missing.errors, JSON.stringify(missing.errors)).toBeUndefined();
    expect(missing.data.resolveUrn).toBeNull();

    // A caller with no reader gets the same null, error-free: the reader gate must
    // hold on this arm too, not only on grant(ref:) (a resolution would hand a
    // no-reader caller the grant's id — an existence oracle).
    const noReader = await post(rawKey, null, RESOLVE, { u: g.urn });
    expect(noReader.errors, JSON.stringify(noReader.errors)).toBeUndefined();
    expect(noReader.data.resolveUrn).toBeNull();
  });

  it('a grant held by another worker, and a caller with no reader, answer as missing', async () => {
    // A REAL second worker of the same App, so the row is in the reader's App and
    // out of scope only because it names another worker — the direct holder arm.
    const otherWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'g-worker-2', slug: `g-worker-2-${generateId().slice(0, 8)}` } });
    const otherWorkerGrant = await heldGrant({ worker_id: otherWorker.id });
    const r1 = await asWorker(ONE, { r: otherWorkerGrant.urn });
    // Null AND error-free: a typed not-found on the wire would be an existence
    // oracle (cor:api:140:02 — the same answer as a missing id, never an error).
    expect(r1.errors, JSON.stringify(r1.errors)).toBeUndefined();
    expect(r1.data.grant).toBeNull();

    const r2 = await post(rawKey, null, ONE, { r: otherWorkerGrant.urn });
    expect(r2.errors, JSON.stringify(r2.errors)).toBeUndefined();
    expect(r2.data.grant).toBeNull();

    // A no-reader caller with a MALFORMED URN: the reader gate runs BEFORE the
    // ref resolves, so this is the same null — never URN_NOT_QUALIFIED, which
    // would tell a no-reader caller their ref's shape was heard (the gate order
    // the SDL promises: every other caller answers null, no error).
    const r2m = await post(rawKey, null, ONE, { r: `hrn:grant:${orgUrn}` });
    expect(r2m.errors, JSON.stringify(r2m.errors)).toBeUndefined();
    expect(r2m.data.grant).toBeNull();

    // A well-formed URN whose leaf names nothing: null, never a typed not-found
    // on the wire — the catch around resolveGrantRef must conceal the miss
    // exactly as the row scope conceals an out-of-scope row (cor:api:140:02).
    const r3 = await asWorker(ONE, { r: composeGrantUrnV2(orgUrn, APP_SLUG, generateId()) });
    expect(r3.errors, JSON.stringify(r3.errors)).toBeUndefined();
    expect(r3.data.grant).toBeNull();
  });

  it('a URN of ANOTHER App names nothing even when its leaf is a grant the reader could read (the App match)', async () => {
    // The leaf must be the reader's own readable grant, so ONLY the URN's App
    // makes it a miss: without resolveGrantRef's `row.appId !== appId` check
    // this URN would resolve through app2's slug and address the grant — a
    // wrong URN must not name a real row (the #3709 review round's unpinned
    // guard, folded from the seat findings).
    const g = await heldGrant();
    const wrongAppUrn = composeGrantUrnV2(orgUrn, 'app2', g.id);

    const byRef = await asWorker(ONE, { r: wrongAppUrn });
    expect(byRef.errors, JSON.stringify(byRef.errors)).toBeUndefined();
    expect(byRef.data.grant).toBeNull();

    const resolved = await asWorker(RESOLVE, { u: wrongAppUrn });
    expect(resolved.errors, JSON.stringify(resolved.errors)).toBeUndefined();
    expect(resolved.data.resolveUrn).toBeNull();

    // Control: the same leaf under its OWN App's slug resolves, so the nulls
    // above are the App match refusing, not the leaf failing isId or the guard
    // rejecting every URN.
    const ok = await asWorker(ONE, { r: g.urn });
    expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
    expect(ok.data.grant?.id).toBe(g.id);
  });

  it('a malformed or wrong-type URN is the typed input refusal URN_NOT_QUALIFIED (acceptance 3)', async () => {
    const malformed = await asWorker(ONE, { r: `hrn:grant:${orgUrn}` });
    expect(malformed.errors?.[0]?.extensions?.code).toBe('URN_NOT_QUALIFIED');

    const wrongType = await asWorker(ONE, { r: `hrn:worker:${orgUrn}:${APP_SLUG}:g-worker` });
    expect(wrongType.errors?.[0]?.extensions?.code).toBe('URN_NOT_QUALIFIED');

    // A ref that is neither an id nor a URN is the SAME refusal — the entity-ref
    // convention treats anything that isn't a known id shape as a URN attempt
    // (entityRef/shape.ts), and the SDL says so.
    const junk = await asWorker(ONE, { r: 'not-a-ref-at-all' });
    expect(junk.errors?.[0]?.extensions?.code).toBe('URN_NOT_QUALIFIED');

    // resolveUrn conceals what grant(ref:) refuses: the same malformed grant URN
    // (typed `grant`, arity wrong) answers null there, error-free — the arms'
    // documented split. A wrong-TYPE URN is not this arm's case (resolveUrn
    // dispatches it to that type's own arm).
    const concealed = await asWorker(RESOLVE, { u: `hrn:grant:${orgUrn}` });
    expect(concealed.errors, JSON.stringify(concealed.errors)).toBeUndefined();
    expect(concealed.data.resolveUrn).toBeNull();
  });

  it('after an App rename the old-slug URN still resolves through the alias map (acceptance 2)', async () => {
    const g = await heldGrant();
    const oldUrn = g.urn; // names the App by its pre-rename slug
    const app = await db.app.findUniqueOrThrow({ where: { id: w.appId } });
    const newUrn = `${orgUrn}:app-renamed`;
    await db.app.update({ where: { id: w.appId }, data: { urn: newUrn } });
    await recordUrnRename(db, { entityType: 'APP', entityId: app.id, oldUrn: app.urn, newUrn });

    // The old spelling keeps resolving (the alias map), and the platform emits
    // only the current spelling.
    const byOld = await asWorker(ONE_WITH_URN, { r: oldUrn });
    expect(byOld.errors, JSON.stringify(byOld.errors)).toBeUndefined();
    expect(byOld.data.grant?.id).toBe(g.id);
    expect(byOld.data.grant?.urn).toBe(composeGrantUrnV2(orgUrn, 'app-renamed', g.id));

    const byNew = await asWorker(ONE, { r: composeGrantUrnV2(orgUrn, 'app-renamed', g.id) });
    expect(byNew.data.grant?.id).toBe(g.id);

    const resolved = await asWorker(RESOLVE, { u: oldUrn });
    expect(resolved.data.resolveUrn).toMatchObject({ kind: 'grant', id: g.id });
  });

  it('a soft-deleted App conceals its grants on the URN path as on the id path', async () => {
    const g = await heldGrant();
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    const r = await asWorker(ONE, { r: g.urn });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data.grant).toBeNull();
  });
});
