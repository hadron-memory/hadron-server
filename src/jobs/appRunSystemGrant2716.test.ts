/**
 * #2716 (N2): the run-upsert door refuses a write grant that sits on a class=system memory (cor:agt:010:01, Holger
 * D1, 2026-10-28; #2710). #2714's existing-row pin goes through `writeNodeCore` directly; this one drives the real run
 * output door, `makeProdRunDeps(db).writeOutput` through `executeAppRun`, whose `data.output.writeTo` resolves the
 * destination and asks `canWriteToMemory(..., { destination: { loc, verb: 'upsert' } })` before `writeNodeCore`.
 *
 * Fixture, disclosed: the grant row on the system memory is seeded DIRECTLY, as it could have been made before #2710
 * (the public `setAppMemoryWriteGrant` refuses it now, and is not weakened here). Every other condition is valid: the App
 * is live, the run is userless, the flow entry is readable, the destination is in the App's org, the row is live and
 * covers the loc. The ONLY difference between the refused cases and the positive control is the destination's class.
 * The run principal has no on-behalf-of user and no agent memory item on either destination.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbRunConsentPrincipal } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

import { mintAppRun, executeAppRun, type RunExecutionDeps } from './appRuns.js';
import { makeProdRunDeps } from './appRunDeps.js';

const ORG_URN = 'sysgrant2716-org';
const FLOW_URN = `${ORG_URN}:flow`;
const SYSTEM_URN = `${ORG_URN}:iris-system`;
const SHARED_URN = `${ORG_URN}:shared`;
const ENTRY = `${ORG_URN}::flow::flow:report`;
const PREFIX = 'boot';
const LOC = `${PREFIX}:source`;

let orgId: string, appId: string, flowId: string, systemId: string, sharedId: string, graniterId: string;

async function run(writeTo: string, mode: 'replace' | 'append' = 'replace') {
  await db.node.update({
    where: { loc_memoryId: { loc: 'flow:report', memoryId: flowId } },
    data: { data: { output: { writeTo, mode } } as never },
  });
  const minted = await mintAppRun(db, { organizationId: orgId, appId, triggerKind: 'MANUAL', entryNodeUrn: ENTRY, eventData: {}, consentPrincipal: await createDbRunConsentPrincipal(db, orgId, appId) });
  const deps: RunExecutionDeps = {
    ...makeProdRunDeps(db),
    resolveConfig: vi.fn(async () => ({ config: { provider: 'anthropic', model: 'test' } }) as never),
    llm: vi.fn(async () => ({ text: 'RUN OUTPUT', tokensIn: 1, tokensOut: 1, provider: 'anthropic', model: 'test' })),
    onTerminal: undefined,
  };
  const outcome = await executeAppRun(db, minted.id, deps);
  const row = await db.appRun.findUniqueOrThrow({ where: { id: minted.id } });
  return { outcome, run: row, failure: row.failure as { code: string; message: string } | null };
}

/** Everything a write to `memoryId` could leave behind. */
const footprint = async (memoryId: string) => ({
  nodes: await db.node.findMany({ where: { memoryId }, orderBy: { loc: 'asc' }, select: { loc: true, content: true, updatedAt: true } }),
  revisions: await db.nodeRevision.count({ where: { node: { memoryId } } }),
  edges: await db.edge.count({ where: { OR: [{ source: { memoryId } }, { target: { memoryId } }] } }),
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG_URN, urn: ORG_URN } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'sysgrant-app', urn: `${ORG_URN}::app` } })).id;
  graniterId = (await db.user.create({ data: { handle: 'sysgrant2716-manager' } })).id;
  await db.appMember.create({ data: { appId, userId: graniterId, role: 'owner' } });
  flowId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'flow', urn: FLOW_URN, class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  systemId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'iris-system', urn: SYSTEM_URN, class: 'system' } as never })).id;
  sharedId = (await db.memory.create({ data: { id: generateId(), organizationId: orgId, name: 'shared', urn: SHARED_URN, class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'iris', urn: `${ORG_URN}:iris`, systemMemoryId: systemId } as never });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  // Read access to the flow memory only: no agent memory item touches either destination.
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: flowId, role: 'read' } });
  await db.node.create({ data: { id: generateId(), memoryId: flowId, loc: 'flow:report', name: 'report', tags: [], content: 'Produce the report.' } as never });
  for (const memoryId of [systemId, sharedId]) {
    await db.appMemoryWriteGrant.create({ data: { appId, memoryId, prefix: PREFIX, grantedBy: graniterId } });
  }
});

describe('#2716 N2: the run-upsert door and a write grant on a class=system memory', () => {
  it('fresh target: a userless run under a live grant on a system memory is refused, and nothing is written', async () => {
    const before = await footprint(systemId);
    const { outcome, failure } = await run(`hrn:node:${SYSTEM_URN}:${LOC}`);
    expect(outcome).toBe('failed');
    expect(failure?.code).toBe('OUTPUT_WRITE_FAILED');
    expect(failure?.message).toContain(SYSTEM_URN);
    expect(failure?.message).toMatch(/not granted/i);
    expect(await footprint(systemId)).toEqual(before);
    expect(await db.node.count({ where: { memoryId: systemId } })).toBe(0);
  });

  it('existing target: the same run cannot replace or append to a node already in the system memory', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: systemId, loc: LOC, name: 'source', tags: [], content: 'ORIGINAL BOOT SOURCE' } as never });
    const before = await footprint(systemId);
    for (const mode of ['replace', 'append'] as const) {
      const { outcome, failure } = await run(`hrn:node:${SYSTEM_URN}:${LOC}`, mode);
      expect(outcome).toBe('failed');
      expect(failure?.code).toBe('OUTPUT_WRITE_FAILED');
      expect(failure?.message).toMatch(/not granted/i);
      expect(await footprint(systemId)).toEqual(before);
    }
    expect((await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: LOC, memoryId: systemId } } })).content).toBe('ORIGINAL BOOT SOURCE');
  });

  it('CONTROL: an identical live grant on a shared knowledge memory of the same org lets the same run write', async () => {
    const { outcome, run: row } = await run(`hrn:node:${SHARED_URN}:${LOC}`);
    expect(outcome).toBe('completed');
    expect(row.userId ?? null).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: LOC, memoryId: sharedId } } })).content).toBe('RUN OUTPUT');
    // And the system memory's own refusal is not an artifact of a missing row: its grant is still live.
    expect(await db.appMemoryWriteGrant.count({ where: { appId, memoryId: systemId, revokedAt: null } })).toBe(1);
  });
});
