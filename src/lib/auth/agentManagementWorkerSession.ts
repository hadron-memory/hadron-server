// #3030 (cor:agt:080:35, V19): a worker session never carries its holder's right to manage an Agent.
//
// The doors that manage an Agent judge the PERSON behind the call (`requireAgentAccess(..., 'ADMIN')`). Under a bound
// worker session that person is the worker's holder, so without this guard a worker whose holder manages the Agent
// could edit the Agent's definition. The rule judges the worker instead, as the boot-prompt guard does
// (`assertNoWorkerSessionBootPromptWrite`, cor:agt:040:11), and no grant path is specified, so the refusal is
// unconditional. The worker is read from the request's published actor (`boundWorkerId`), which the HTTP session
// binding, the MCP connection binding and `runAsActor` all fill.
//
// Callers decide it inside the deciding transaction, right after the person gate's re-check, before any row lock or
// existence, revision or name check. It is not a pre-check outside the transaction: a holder demoted while the write
// waits on the authority anchors must still get the person gate's FORBIDDEN, which is how the decision is judged
// against the state it commits on (Beckett, LOCAL P2-2 on #3044).
//
// The one thing decided before the transaction is a target that does not resolve. Under a worker session a missing,
// deleted, malformed or unreadable target answers with this same refusal (`absentAsWorkerRefusal`, BLIND P2 on #3044).
// What the answer reveals is therefore bounded by the holder's READ access: a target on an Agent the holder cannot read
// answers like an absent one, and FORBIDDEN (holder reads but does not manage the Agent) is only seen on a target the
// same worker can already read. Outside a worker session the not-found answer is unchanged.

import { GraphQLError } from 'graphql';
import { boundWorkerId } from '../bootPrompt.js';

export const AGENT_MANAGEMENT_WORKER_SESSION_REFUSED = 'AGENT_MANAGEMENT_WORKER_SESSION_REFUSED';

export type AgentManagementOp =
  | 'createAgentTickerTemplate'
  | 'updateAgentTickerTemplate'
  | 'deleteAgentTickerTemplate'
  | 'setAgentModelGroup'
  | 'deleteAgentModelGroup';

export function agentManagementWorkerSessionError(op: AgentManagementOp): GraphQLError {
  return new GraphQLError(
    `${AGENT_MANAGEMENT_WORKER_SESSION_REFUSED}: a worker session never manages an Agent (${op}); its manager does it as themselves.`,
    { extensions: { code: AGENT_MANAGEMENT_WORKER_SESSION_REFUSED, op } },
  );
}

/** Whether this request runs under a bound worker session. */
export function underWorkerSession(): boolean {
  return boundWorkerId() !== null;
}

/** Refuse an Agent-management write under a bound worker session, whatever its holder may do. */
export function assertNoWorkerSessionAgentManagement(op: AgentManagementOp): void {
  if (underWorkerSession()) throw agentManagementWorkerSessionError(op);
}

/**
 * Load a write's target; under a worker session, a target that does not resolve answers with the worker refusal
 * instead of its not-found, so the answer does not depend on whether the row exists. Anything else is rethrown.
 */
export async function absentAsWorkerRefusal<T>(op: AgentManagementOp, load: () => Promise<T>, isAbsent: (e: unknown) => boolean): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (underWorkerSession() && isAbsent(e)) throw agentManagementWorkerSessionError(op);
    throw e;
  }
}
