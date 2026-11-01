// #3030 (cor:agt:080:35, V19): a worker session never carries its holder's right to manage an Agent.
//
// The doors that manage an Agent judge the PERSON behind the call (`requireAgentAccess(..., 'ADMIN')`). Under a bound
// worker session that person is the worker's holder, so without this guard a worker whose holder manages the Agent
// could edit the Agent's definition. The rule judges the worker instead, as the boot-prompt guard does
// (`assertNoWorkerSessionBootPromptWrite`, cor:agt:040:11), and no grant path is specified, so the refusal is
// unconditional. The worker is read from the request's published actor (`boundWorkerId`), which the HTTP session
// binding, the MCP connection binding and `runAsActor` all fill.
//
// Callers decide it inside the deciding transaction, next to the person gate and before any existence, revision or
// name check, so the refusal says nothing about the row it was aimed at and nothing is written.

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
