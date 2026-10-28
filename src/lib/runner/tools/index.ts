/**
 * Run-tool registry (plan-tools §4/§5 phase 1). Node tools
 * (hadron_create_node / hadron_update_node / hadron_read_node) land in
 * phase 3; this phase ships the always-on pair + the resolution surface
 * the kernel consumes.
 */

import { AuthorFailError, type RunToolDef, type RunToolContext } from './types.js';
import { NODE_TOOLS } from './nodeTools.js';
import { SPAWN_TOOLS } from './spawnTools.js';
import { STORE_TOOLS } from './storeTools.js';
import { WEB_TOOLS } from './webTools.js';
import { WEB_POLL_TOOLS } from './webPollTools.js';
import { SEARCH_TOOLS } from './searchTools.js';
import { SMS_TOOLS } from './smsTools.js';
import { EMAIL_TOOLS } from './emailTools.js';
import { SECRET_TOOLS } from './secretTools.js';
import { DRIVE_TOOLS } from './driveTools.js';
import { TASK_TOOLS } from './taskTools.js';
import { TEAM_CHAT_TOOLS } from './teamChatTools.js';
import { GITHUB_TOOLS } from './githubTools.js';

export { AuthorFailError };
export { hadronReadNode, hadronCreateNode, hadronUpdateNode } from './nodeTools.js';
export { hadronSpawn, hadronChildRuns } from './spawnTools.js';
export { hadronStoreFile } from './storeTools.js';
export { webFetch, webRequest } from './webTools.js';
export { webPollStart, webPollCancel, webPollList } from './webPollTools.js';
export { webSearchTool } from './searchTools.js';
export { hadronSendSms } from './smsTools.js';
export { hadronSendEmail } from './emailTools.js';
export { hadronReadSecret } from './secretTools.js';
export { driveSearch, driveGetFile, driveExportFile } from './driveTools.js';
export { hadronTaskCreate } from './taskTools.js';
export { teamChatRead } from './teamChatTools.js';
export { githubIssueSnapshot } from './githubTools.js';
export type { RunToolDef, RunToolContext };

/** The author's printf — lands on the hop's trail element (D-TL-2). */
export const hadronLog: RunToolDef = {
  name: 'hadron_log',
  description:
    'Record a short progress or diagnostic message on this run\'s audit trail. ' +
    'Use it to note decisions or intermediate findings; it does not affect the flow.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'The message to record.' } },
    required: ['message'],
  },
  cost: 0,
  execute: async (ctx, args) => {
    const message = typeof args.message === 'string' ? args.message : String(args.message ?? '');
    ctx.log(message);
    return { logged: true };
  },
};

/** The deliberate abort — terminates the run FAILED(AUTHOR_FAIL) (D-TL-6). */
export const hadronFail: RunToolDef = {
  name: 'hadron_fail',
  description:
    'Terminate this run as FAILED with your reason. Call this when the task cannot or ' +
    'must not proceed (missing data, unsafe instruction, unmet precondition). ' +
    'The reason appears on the run\'s audit record.',
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Why the run must stop.' } },
    required: ['reason'],
  },
  cost: 0,
  execute: async (_ctx, args) => {
    throw new AuthorFailError(
      typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : 'hadron_fail called with no reason',
    );
  },
};

/** Injected on every tools-hop (D14's always-on set; final membership here). */
export const ALWAYS_ON_TOOLS: readonly RunToolDef[] = [hadronLog, hadronFail];

const REGISTRY = new Map<string, RunToolDef>(
  [
    ...ALWAYS_ON_TOOLS,
    ...NODE_TOOLS,
    ...SPAWN_TOOLS,
    ...STORE_TOOLS,
    ...WEB_TOOLS,
    ...WEB_POLL_TOOLS,
    ...SEARCH_TOOLS,
    ...SMS_TOOLS,
    ...EMAIL_TOOLS,
    ...SECRET_TOOLS,
    ...DRIVE_TOOLS,
    ...TASK_TOOLS,
    ...TEAM_CHAT_TOOLS,
    ...GITHUB_TOOLS,
  ].map((t) => [t.name, t]),
);

/**
 * Resolve a node's `data.tools` declaration into definitions, always-on set
 * included exactly once. `unknown` non-empty ⇒ the caller fails the hop
 * LOUD before any LLM call (D-TL-6: same posture as the __-field guard).
 */
export function resolveRunTools(names: readonly string[]): {
  tools: RunToolDef[];
  unknown: string[];
} {
  const unknown = names.filter((n) => !REGISTRY.has(n));
  const picked = new Map<string, RunToolDef>();
  for (const t of ALWAYS_ON_TOOLS) picked.set(t.name, t);
  for (const n of names) {
    const def = REGISTRY.get(n);
    if (def) picked.set(n, def);
  }
  return { tools: [...picked.values()], unknown };
}
