import type { PrismaClient } from '../generated/prisma/index.js';
import { activeMemoryWriteGrant } from './appGrants5404.js';

/**
 * #4624 — the E2E stack's script-node fixture flows (cor:agt:010:04). A script node makes one run-tool call with NO
 * model hop (src/jobs/appRuns.ts), so a run of it executes on a stack that holds no AI config, LLM key or tool URL.
 * The tool is `hadron_create_node`: an in-process write, nothing leaves the stack.
 *
 * One synthetic knowledge memory per org carries two entry flows. Authority is NOT stubbed: the run resolves its principal
 * and its write authority through the product (consent principal, a signed `memory.write` grant (#5404), policy chain), so the fixture only
 * supplies the data those paths read:
 *  - `flows:script-write` creates `runs:script-write-result`, a loc under the one prefix the App holds a write grant for;
 *  - `flows:script-refused` targets `denied:script-refused-result`, under a prefix with NO grant, so the product refuses it.
 * Called by scripts/e2e/seed.ts, and src/test/e2eScriptFlow.test.ts runs what it builds through the real run path.
 */
export const E2E_SCRIPT_WRITE_ENTRY = 'flows:script-write';
export const E2E_SCRIPT_REFUSED_ENTRY = 'flows:script-refused';
export const E2E_SCRIPT_WRITE_RESULT = 'runs:script-write-result';
export const E2E_SCRIPT_REFUSED_RESULT = 'denied:script-refused-result';
export const E2E_SCRIPT_GRANT_PREFIX = 'runs';

/**
 * #4753: the flow fixtures exist only on a stack started with E2E_RUN_WORKER=true (README). stack.sh maps exactly that
 * value to DISABLE_RUN_WORKER=false inside the container and leaves every other value `true`, so the seed and the verifier,
 * which both run in the container, read the one variable the run worker itself reads, and only the exact value `false`
 * counts (an unset or mistyped value leaves the fixtures off, as for the worker).
 *
 * The two readers are not the same predicate off that path: the server runs the worker unless DISABLE_RUN_WORKER is exactly
 * `true` (src/server.ts), while this enables the fixtures only on exactly `false`. Under stack.sh they always agree, since it
 * sets one or the other; a variable set by hand to anything else (e.g. `0`) would run the worker without its flows seeded.
 */
export const e2eFlowFixturesEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  env.DISABLE_RUN_WORKER === 'false';

export const e2eFlowsMemoryUrn = (org: string): string => `${org}:flows`;
/** The canonical node URN of a loc in the org's fixture flow memory. */
export const e2eFlowNodeUrn = (org: string, loc: string): string => `hrn:node:${org}:flows:${loc}`;

export async function seedE2eScriptFlow(db: PrismaClient, o: {
  org: string; organizationId: string; appId: string; agentId: string; grantedBy: string;
  id: (name: string) => string;
}): Promise<{ memoryId: string }> {
  const memoryId = o.id(`${o.org}:flows`);
  await db.memory.create({ data: { id: memoryId, organizationId: o.organizationId, urn: e2eFlowsMemoryUrn(o.org),
    // The agent holds only the lesser 'read' role here: the write below rides the App write grant ALONE (the tests prove it).
    // PUBLIC gives the userless run its reads (#3278); writes still need the App grant below. Synthetic content only.
    name: `${o.org} flows`, class: 'knowledge', visibility: 'PUBLIC', tags: ['e2e'] } });
  await db.agentMemoryItem.create({ data: { id: o.id(`${o.org}:flows:item`), agentId: o.agentId, memoryId, role: 'read' } });
  const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: o.id(`${o.org}:flows:${loc}`),
    memoryId, loc, name: loc.split(':').pop()!, tags: ['e2e'], ...extra } as never });
  // The register node the fixture's write authority cites (cor:acl, the grant's own record).
  await node('register:script-fixture-authority', { content: 'Synthetic E2E fixture: the authority the script write grant cites.' });
  // #5404: the App's write authority is a signed `memory.write` grant on the one prefix (ruling 0083's unsigned row is retired),
  // written ACTIVE around the signing ceremony. `grantedBy` signs it, so it must manage the flows memory for the write to count.
  await activeMemoryWriteGrant(o.appId, memoryId, { issuerUserId: o.grantedBy, prefix: E2E_SCRIPT_GRANT_PREFIX, db });
  const call = (loc: string) => ({ script: { call: { tool: 'hadron_create_node', args: {
    urn: e2eFlowNodeUrn(o.org, loc), name: 'Script result', content: 'Written by the script-node fixture run.', nodeType: 'info' } } } });
  await node(E2E_SCRIPT_WRITE_ENTRY, { data: call(E2E_SCRIPT_WRITE_RESULT) as never });
  await node(E2E_SCRIPT_REFUSED_ENTRY, { data: call(E2E_SCRIPT_REFUSED_RESULT) as never });
  return { memoryId };
}

/** #4753: seed the flows only when the stack runs the worker; `null` when it does not (nothing is written). */
export async function seedE2eScriptFlowIfEnabled(
  db: PrismaClient,
  o: Parameters<typeof seedE2eScriptFlow>[1],
  env: Record<string, string | undefined> = process.env,
): Promise<{ memoryId: string } | null> {
  return e2eFlowFixturesEnabled(env) ? seedE2eScriptFlow(db, o) : null;
}
