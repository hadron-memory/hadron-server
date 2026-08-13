/**
 * #950 — the data fix for personas minted before createTeamPersona set their
 * metadata correctly (PERSONAL visibility + the role node's own description).
 *
 * The description rewrite is evidence-based on purpose: it fires only where
 * the persona's description is still a verbatim copy of the role node's, so a
 * hand-edited description survives the sweep.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { planPersonaRepairs, applyPersonaRepairs } from './teamPersonaRepair.js';

const ROLE_NODE_DESCRIPTION =
  'Role definition + name register for Micromentor backend engineers';

let org: { id: string; urn: string };
let teamAgentId: string;
let sysMemoryId: string;
let appId: string;

/** Mint the broken state: a PERSONAL persona whose description was copied. */
async function makePersona(opts: {
  name: string;
  slug: string;
  description?: string | null;
  visibility?: 'PERSONAL' | 'ORGANIZATION';
  ownerUserId?: string;
}) {
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      ...(opts.ownerUserId
        ? { ownerUserId: opts.ownerUserId }
        : { organizationId: org.id }),
      urn: `${opts.ownerUserId ? 'u' : org.urn}:${opts.slug}`,
      name: opts.name,
      description: opts.description === undefined ? ROLE_NODE_DESCRIPTION : opts.description,
      visibility: opts.visibility ?? 'PERSONAL',
      personaName: opts.name,
      personaRole: 'backend-engineer',
    },
  });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  return agent;
}

beforeEach(async () => {
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'persona-repair', urn: `persona-repair-${s}.com` },
  });
  const sys = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:team-agent-system`,
      name: 'Team Agent System',
      class: 'system',
      acceptsUploads: false,
    },
  });
  sysMemoryId = sys.id;
  const teamAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:team-agent`,
      name: 'Team Agent',
      visibility: 'ORGANIZATION',
      systemMemoryId: sys.id,
    },
  });
  teamAgentId = teamAgent.id;
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: sys.id,
      loc: 'roles:backend-engineer',
      name: 'backend-engineer',
      description: ROLE_NODE_DESCRIPTION,
      content: 'You are {{name}}, a {{role}}.',
      data: { names: ['Iris', 'Rufus'] },
    },
  });
  const app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Eng Team', urn: `${org.urn}:eng-team` },
  });
  appId = app.id;
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
});

describe('planPersonaRepairs', () => {
  it('plans both fixes for a persona minted with the old defaults', async () => {
    const iris = await makePersona({ name: 'Iris', slug: 'iris' });
    const plans = await planPersonaRepairs(db);
    const plan = plans.find((p) => p.agentId === iris.id);
    expect(plan?.visibility).toEqual({ from: 'PERSONAL', to: 'ORGANIZATION' });
    expect(plan?.description).toEqual({
      from: ROLE_NODE_DESCRIPTION,
      to: 'AI coding agent using backend-engineer role',
    });
  });

  it('honors data.personaDescription on the role node', async () => {
    await db.node.updateMany({
      where: { memoryId: sysMemoryId, loc: 'roles:backend-engineer' },
      data: { data: { names: ['Iris'], personaDescription: '{{name}}, {{role}}' } },
    });
    const iris = await makePersona({ name: 'Iris', slug: 'iris' });
    const plans = await planPersonaRepairs(db);
    expect(plans.find((p) => p.agentId === iris.id)?.description?.to).toBe('Iris, backend-engineer');
  });

  it('leaves a hand-edited description alone', async () => {
    const iris = await makePersona({
      name: 'Iris',
      slug: 'iris',
      description: 'Iris keeps the GraphQL surface honest.',
    });
    const plans = await planPersonaRepairs(db);
    const plan = plans.find((p) => p.agentId === iris.id);
    expect(plan?.description).toBeUndefined();
    // The visibility fix still applies.
    expect(plan?.visibility).toEqual({ from: 'PERSONAL', to: 'ORGANIZATION' });
  });

  it('never changes visibility on a user-owned persona (spec 047 keeps it PERSONAL)', async () => {
    const user = await db.user.create({
      data: { id: generateId(), githubId: 96001, githubUsername: `pr-user-${Date.now()}`, roles: ['READER'] },
    });
    const mine = await makePersona({ name: 'Ada', slug: 'ada', ownerUserId: user.id });
    const plans = await planPersonaRepairs(db);
    expect(plans.find((p) => p.agentId === mine.id)?.visibility).toBeUndefined();
  });

  it('is idempotent — a repaired persona produces no further plan', async () => {
    const iris = await makePersona({ name: 'Iris', slug: 'iris' });
    const written = await applyPersonaRepairs(db, await planPersonaRepairs(db));
    expect(written).toBe(1);
    const after = await db.agent.findUniqueOrThrow({ where: { id: iris.id } });
    expect(after.visibility).toBe('ORGANIZATION');
    expect(after.description).toBe('AI coding agent using backend-engineer role');

    const second = await planPersonaRepairs(db);
    expect(second.find((p) => p.agentId === iris.id)?.visibility).toBeUndefined();
    expect(second.find((p) => p.agentId === iris.id)?.description).toBeUndefined();
  });

  it('skips a persona whose role node lives in an encrypted memory', async () => {
    await db.memory.update({ where: { id: sysMemoryId }, data: { isEncrypted: true } });
    const iris = await makePersona({ name: 'Iris', slug: 'iris' });
    const plan = (await planPersonaRepairs(db)).find((p) => p.agentId === iris.id);
    expect(plan?.description).toBeUndefined();
    expect(plan?.note).toMatch(/encrypted/);
  });

  it('ignores non-persona Agents', async () => {
    const plans = await planPersonaRepairs(db);
    expect(plans.find((p) => p.agentId === teamAgentId)).toBeUndefined();
  });
});
