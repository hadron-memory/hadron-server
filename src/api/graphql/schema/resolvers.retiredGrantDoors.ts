/**
 * #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, hrn:node:hadronmemory.com:specs:cor:agt:010:01; Holger, 2026-11-27, "Retire
 * all"; the gate's two decisions, hadron-server#5404 comment 7218964670): the doors of the two unsigned App grants retire.
 *  - the per-automation read grant of #2883: `setAutomationReadGrant`, `revokeAutomationReadGrant`, `automationReadGrants`;
 *  - the App write grant of ruling 0083 (#2484): `setAppMemoryWriteGrant`, `revokeAppMemoryWriteGrant`, `appMemoryWriteGrants`.
 *
 * Their rows are deleted at deploy and nothing reads them. During the deprecation window every door REFUSES, so no new unsigned row
 * can appear: a door that wrote a row nothing reads would look like a grant of authority that does not exist. The refusal is one fixed
 * `DOOR_RETIRED`, judged before any lookup, for every caller and every argument, so it reveals nothing about what the arguments name.
 * It names the replacement: a signed `memory.read` or `memory.write` grant through `createGrant`. The fields stay in the SDL,
 * deprecated, until the window ends; then they, the MCP tools that delegate here and the four tables go (a separate contract step).
 */
import { GraphQLError } from 'graphql';

export const DOOR_RETIRED = 'DOOR_RETIRED';

function retired(door: string, replacement: 'memory.read' | 'memory.write'): GraphQLError {
  return new GraphQLError(
    `${door} is retired: give a signed ${replacement} grant with createGrant instead.`,
    { extensions: { code: DOOR_RETIRED, replacement } },
  );
}

const refuse = (door: string, replacement: 'memory.read' | 'memory.write') => async (): Promise<never> => {
  throw retired(door, replacement);
};

export const retiredGrantDoorQueries = {
  automationReadGrants: refuse('automationReadGrants', 'memory.read'),
  appMemoryWriteGrants: refuse('appMemoryWriteGrants', 'memory.write'),
};

export const retiredGrantDoorMutations = {
  setAutomationReadGrant: refuse('setAutomationReadGrant', 'memory.read'),
  revokeAutomationReadGrant: refuse('revokeAutomationReadGrant', 'memory.read'),
  setAppMemoryWriteGrant: refuse('setAppMemoryWriteGrant', 'memory.write'),
  revokeAppMemoryWriteGrant: refuse('revokeAppMemoryWriteGrant', 'memory.write'),
};
