/**
 * Integration tests for Query.resolveUrn (hadron-portal#262).
 *
 * resolveUrn dispatches on a `urn:<type>:`-prefixed URN's type segment and
 * returns the ids the portal's /app/u/<urn> redirect route needs to reach
 * each resource's canonical page. It reuses the entity-ref resolvers and the
 * same per-kind authorization as the dedicated memory/node/org/agent/app
 * queries, collapsing both not-found and no-access to null so existence is
 * never disclosed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const ORG_URN = 'urnres-org';
const MEM_URN = `${ORG_URN}:mem`;
const AGENT_URN = `${ORG_URN}:the-agent`;
const APP_URN = `${ORG_URN}:the-app`;
const NODE_LOC = 'topic';

let org: { id: string };
let memory: { id: string };
let node: { id: string };
let agent: { id: string };
let app: { id: string };
let member: { id: string }; // ADMIN of the org (so the app ADMIN gate passes)
let outsider: { id: string }; // member of no org

function memberCtx(): Context {
  return { db, userId: member.id, roles: ['READER'] };
}
function outsiderCtx(): Context {
  return { db, userId: outsider.id, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'urnres-org', urn: ORG_URN },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: MEM_URN,
      name: 'mem',
      class: 'knowledge',
      // ORGANIZATION-visible so the node-access filter (which respects
      // PRIVATE visibility, unlike the membership-only memory gate) admits
      // org members.
      visibility: 'ORGANIZATION',
    },
  });
  node = await db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc: NODE_LOC, name: 'Topic' },
  });
  agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: AGENT_URN, name: 'the-agent' },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: APP_URN, name: 'the-app' },
  });

  member = await db.user.create({
    data: { id: generateId(), githubId: 7301, githubUsername: 'urnres-member', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' },
  });

  outsider = await db.user.create({
    data: { id: generateId(), githubId: 7302, githubUsername: 'urnres-outsider', roles: ['READER'] },
  });
});

describe('Query.resolveUrn — resolves each kind for an authorized caller', () => {
  it('resolves a memory URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:memory:${MEM_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'memory', id: memory.id });
  });

  it('resolves a node URN and includes its memoryId', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:node:${MEM_URN}:${NODE_LOC}` },
      memberCtx(),
    );
    expect(r).toEqual({ kind: 'node', id: node.id, memoryId: memory.id });
  });

  it('resolves an org URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:org:${ORG_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'org', id: org.id });
  });

  it('resolves an agent URN', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:agent:${AGENT_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'agent', id: agent.id });
  });

  it('resolves an app URN and includes its organizationId', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:app:${APP_URN}` }, memberCtx());
    expect(r).toEqual({ kind: 'app', id: app.id, organizationId: org.id });
  });
});

describe('Query.resolveUrn — user (hrn:user:<handle>)', () => {
  it('resolves the caller themselves', async () => {
    await db.user.update({ where: { id: member.id }, data: { handle: 'urnres-self-h' } });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-self-h' }, memberCtx());
    expect(r).toEqual({ kind: 'user', id: member.id });
  });

  it('resolves a user who shares an org with the caller', async () => {
    const peer = await db.user.create({
      data: { id: generateId(), githubId: 7303, githubUsername: 'urnres-peer', handle: 'urnres-peer-h', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: peer.id, role: 'READER' },
    });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-peer-h' }, memberCtx());
    expect(r).toEqual({ kind: 'user', id: peer.id });
  });

  it('returns null for a user who shares no org with the caller', async () => {
    await db.user.update({ where: { id: member.id }, data: { handle: 'urnres-noshare-h' } });
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:urnres-noshare-h' }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('a platform admin resolves any user', async () => {
    await db.user.update({ where: { id: outsider.id }, data: { handle: 'urnres-outsider-h' } });
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: 'hrn:user:urnres-outsider-h' },
      { db, userId: member.id, roles: ['ADMIN'] },
    );
    expect(r).toEqual({ kind: 'user', id: outsider.id });
  });

  it('returns null for an unknown handle', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: 'hrn:user:nobody-urnres' }, memberCtx());
    expect(r).toBeNull();
  });
});

describe('Query.resolveUrn — access control collapses to null', () => {
  it('returns null for a memory the caller cannot access', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:memory:${MEM_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('returns null for a node the caller cannot access', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:node:${MEM_URN}:${NODE_LOC}` },
      outsiderCtx(),
    );
    expect(r).toBeNull();
  });

  it('returns null for an org the caller is not a member of', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:org:${ORG_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('returns null for an agent in an org the caller is not a member of', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: `urn:agent:${AGENT_URN}` }, outsiderCtx());
    expect(r).toBeNull();
  });

  it('returns null for an app the caller is not org ADMIN of', async () => {
    // A CONTRIBUTOR member can read the org but is below the app ADMIN gate.
    const contributor = await db.user.create({
      data: { id: generateId(), githubId: 7303, githubUsername: 'urnres-contrib', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:app:${APP_URN}` },
      { db, userId: contributor.id, roles: ['READER'] },
    );
    expect(r).toBeNull();
  });
});

describe('Query.resolveUrn — unresolvable inputs return null', () => {
  it('returns null for a bare URN with no type prefix (kind ambiguous)', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: MEM_URN }, memberCtx());
    expect(r).toBeNull();
  });

  it('returns null for an unknown type segment', async () => {
    const r = await resolvers.Query.resolveUrn({}, { urn: 'urn:bogus:foo:bar' }, memberCtx());
    expect(r).toBeNull();
  });

  it('returns null for a well-formed URN that names nothing', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${ORG_URN}:does-not-exist` },
      memberCtx(),
    );
    expect(r).toBeNull();
  });

  it('resolves for a global ADMIN regardless of membership', async () => {
    const r = await resolvers.Query.resolveUrn(
      {},
      { urn: `urn:memory:${MEM_URN}` },
      { db, userId: outsider.id, roles: ['ADMIN'] },
    );
    expect(r).toEqual({ kind: 'memory', id: memory.id });
  });
});
