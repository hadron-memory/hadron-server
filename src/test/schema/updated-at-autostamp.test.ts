/**
 * #523 — `updatedAt` must be set on every update.
 *
 * The schema convention (schema.prisma header) is that every entity's
 * `updatedAt` uses Prisma's `@updatedAt`, so it is stamped on create and on
 * every update. 21 models were missing the attribute, leaving `updated_at`
 * NULL forever. This test pins the behavior on a few representative models
 * that previously lacked it (Agent, App, Session, Edge) so a future schema
 * edit can't silently drop `@updatedAt` again.
 *
 * Note: `updatedBy` is intentionally out of scope here — it needs the acting
 * principal's identity (not available to a Prisma-level default) and is
 * tracked separately.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../helpers.js';
import { generateId } from '../../lib/id.js';

// @updatedAt writes a JS `new Date()` (millisecond precision), so create and
// update must be separated by more than one clock tick for the strict-increase
// assertion to hold. 5ms can round to 0 on coarse timers — use a comfortable
// margin (#527 review).
const SETTLE_MS = 25;

beforeEach(async () => {
  await cleanDb(db);
});

describe('#523 — @updatedAt auto-stamps updatedAt on previously-unstamped models', () => {
  it('Agent: set on create, bumped on update', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'ua-org', urn: 'ua-org' },
    });
    const created = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
    });
    // @updatedAt stamps on create too (matches the models that already had it).
    expect(created.updatedAt).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const updated = await db.agent.update({
      where: { id: created.id },
      data: { description: 'changed' },
    });
    expect(updated.updatedAt).toBeInstanceOf(Date);
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(created.updatedAt!.getTime());
  });

  it('App: bumped on update', async () => {
    const org = await db.organization.create({
      data: { id: generateId(), name: 'ua-org2', urn: 'ua-org2' },
    });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' },
    });
    expect(app.updatedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const updated = await db.app.update({
      where: { id: app.id },
      data: { name: 'app-2' },
    });
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(app.updatedAt!.getTime());
  });

  it('Edge: stamped (previously left NULL)', async () => {
    const { graph } = await createDbOrgAndGraph(db);
    const a = await db.node.create({
      data: { id: generateId(), memoryId: graph.id, loc: 'a', isLink: false, name: 'a', tags: [] },
    });
    const b = await db.node.create({
      data: { id: generateId(), memoryId: graph.id, loc: 'b', isLink: false, name: 'b', tags: [] },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(),
        memoryId: graph.id,
        loc: 'a:rel:b',
        sourceId: a.id,
        targetId: b.id,
        name: 'rel',
      },
    });
    expect(edge.updatedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const updated = await db.edge.update({
      where: { id: edge.id },
      data: { name: 'rel2' },
    });
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(edge.updatedAt!.getTime());
  });

  it('Session: set on create, bumped on update', async () => {
    // Session.id is caller-generated; type defaults to DEVELOPER.
    const session = await db.session.create({ data: { id: generateId() } });
    expect(session.updatedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const updated = await db.session.update({
      where: { id: session.id },
      data: { summary: 'touched' },
    });
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(session.updatedAt!.getTime());
  });
});
