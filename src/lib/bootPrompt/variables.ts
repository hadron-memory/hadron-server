/**
 * #2047 (S10) — the platform variable values for a surface that binds no worker: a chat, and a headless run
 * (cor:dmo:150:08). `worker.name` falls back to the Agent's name, `worker.role` to its persona role, `worker.url` is
 * the Agent's portal URL, and reports-to / signature / trailer are empty and the model is empty here (a chat supplies its bounded client report at serving; a run's is filled
 * by the run's mint). One definition, so a chat and a run cannot bind the same prompt differently.
 */
import { portalUrlForUrn } from '../portalUrl.js';
import type { PlatformVariableValues } from '../personaDescription.js';

export function agentPlatformValues(agent: { name: string; urn: string; personaRole: string | null }): PlatformVariableValues {
  return {
    'worker.name': agent.name,
    'worker.role': agent.personaRole ?? '',
    'agent.name': agent.name,
    'worker.reportsTo.name': '',
    'worker.signature': '',
    'worker.trailer': '',
    'worker.url': portalUrlForUrn(agent.urn) ?? '',
    'session.llmModel': '',
  };
}

/**
 * #3843 (cor:dmo:150:08, rulings:0066): the values a surface that binds no worker fills, with the client-reported model
 * (empty when none is reported). A chat serves with exactly these, and the served-prompt read (`agentServedBootPrompt`,
 * `hadron_agent_boot_prompt`) renders with them, so the read and a chat can't fill one prompt differently.
 */
export function noWorkerVariables(
  agent: { name: string; urn: string; personaRole: string | null },
  llmModel: string | null,
): PlatformVariableValues {
  return { ...agentPlatformValues(agent), 'session.llmModel': llmModel ?? '' };
}
