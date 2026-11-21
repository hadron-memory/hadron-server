/**
 * #3558 A: the edge-only revision contract, as the advertised descriptions state it (rulings 0149 and 0198, cor:dmo:060:04). An
 * inline-edge-only write checks a current expectedRevision without consuming it, appends no revision (so no history row for its
 * reason), and edges are not part of what makes an approval older than Node.revision. The strings are the gate's exact text.
 * Red on main: the old descriptions say none of this, and the APPROVED description still lists edges.
 */
import { buildSchema, GraphQLEnumType, GraphQLInputObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { SHAPE_HADRON_UPDATE_NODE } from '../../../mcp/toolShapes.js';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);
const updateInput = schema.getType('UpdateNodeInput') as GraphQLInputObjectType;
const approved = (schema.getType('NodeApprovalState') as GraphQLEnumType).getValue('APPROVED')!;
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const EXPECTED_REVISION_SDL = 'Optional optimistic-concurrency precondition (#937). When supplied, the update is applied only while the node\'s current live revision still equals this positive 32-bit integer. A stale token is refused atomically with NODE_WRITE_CONFLICT and no edges are applied. An inline-edge-only write checks a current token without consuming it: the node\'s revision does not advance and the same token remains valid. Omitting it or passing null preserves last-write-wins compatibility. Read the baseline from Node.revision.';
const REASON_SDL = 'Why this change was made — recorded on the revision-history snapshot (NodeRevision.revLabel, #620; historically it squatted in editedBy), mirroring hadron_update_node\'s reason arg. An inline-edge-only write appends no revision, so it creates no history row on which to record this reason.';
const APPROVED_SDL = 'The approval covers the current text: it was recorded at the revision in NodeApproval.revision, which can be older than Node.revision when only metadata (tags, properties, role, description, alias, loc) changed since.';
const EXPECTED_REVISION_MCP = 'Optional positive Revision value from hadron_get_node. A stale token refuses atomically with [node_write_conflict] and no edges are applied. An inline-edge-only write checks a current token without consuming it: the node\'s revision does not advance and the same token remains valid. Omit for backward-compatible last-write-wins behavior.';
const REASON_MCP = 'Why this change was made (stored in revision history). An inline-edge-only write appends no revision, so it creates no history row on which to record this reason.';

describe('#3558 edge-only revision contract descriptions', () => {
  it('NodeApprovalState.APPROVED does not list edges among the metadata that ages an approval', () => {
    expect(approved.description).toBe(APPROVED_SDL);
    expect(approved.description).not.toContain('edges');
  });
  it('UpdateNodeInput.expectedRevision and reason state the edge-only behavior', () => {
    expect(flat(updateInput.getFields().expectedRevision!.description)).toBe(EXPECTED_REVISION_SDL);
    expect(flat(updateInput.getFields().reason!.description)).toBe(REASON_SDL);
  });
  it('hadron_update_node expectedRevision and reason say the same, with no null phrase (the MCP input is not nullable)', () => {
    expect(SHAPE_HADRON_UPDATE_NODE.expectedRevision.description).toBe(EXPECTED_REVISION_MCP);
    expect(SHAPE_HADRON_UPDATE_NODE.reason.description).toBe(REASON_MCP);
    expect(SHAPE_HADRON_UPDATE_NODE.expectedRevision.description).not.toContain('null');
  });
});
