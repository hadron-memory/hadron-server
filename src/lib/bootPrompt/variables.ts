/**
 * #2047 (S10) — the platform variable values for a surface that binds no worker: a chat, and a headless run
 * (cor:dmo:150:08). `worker.name` falls back to the Agent's name, `worker.role` to its persona role, `worker.url` is
 * the Agent's portal URL, and reports-to / signature / trailer / model are empty (the server calls no model here, the
 * client or the run does). One definition, so a chat and a run cannot bind the same prompt differently.
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
