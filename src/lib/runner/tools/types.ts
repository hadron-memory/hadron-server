/**
 * Run-tool contracts (plan-tools D-TL-2/-3/-6) — the tools a flow node's
 * LLM may call during a hop. Naming follows the MCP convention (locked):
 * `hadron_` prefix, snake_case; policy entries are `tool.<name>`.
 *
 * Phase 1 keeps the context minimal (trail logging); the kernel
 * integration (phase 2) and node tools (phase 3) extend it with the DB
 * handle and run principal.
 */

import type { PrismaClient, AppRun } from '../../../generated/prisma/index.js';
import type { Context } from '../../../api/graphql/schema/resolvers.js';

/** What a tool handler may touch. Built by the kernel per hop. */
export interface RunToolContext {
  /** Append an author-visible line to the current hop's trail (#539). */
  log: (message: string) => void;
  db: PrismaClient;
  run: AppRun;
  /** The run principal (D-2026-07-04-C): Context{appId, userId?} — class
   *  gates apply unchanged inside every handler. */
  principal: Context;
  /** The flow node this hop executes (#2485). Set by the kernel; tools that
   *  take their reach from the node (github_issue_snapshot) read it here. */
  nodeUrn?: string;
}

export interface RunToolDef {
  /** MCP-convention name (`hadron_create_node`); policy action is `tool.<name>`. */
  name: string;
  /** Optional shared policy action for a family of tool names. Defaults to
   *  `tool.<name>`; e.g. every web_poll_* operation uses `tool.web_poll`. */
  policyAction?: `tool.${string}`;
  description: string;
  /** JSON Schema (curated subset — same posture as Node.schema, D15). */
  inputSchema: Record<string, unknown>;
  /** Action-budget cost per call (D-TL-2: writes 1; reads/log 0). */
  cost: 0 | 1;
  execute: (ctx: RunToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Thrown by `hadron_fail` — the author's DELIBERATE abort. The kernel maps
 * it to `FAILED({code: 'AUTHOR_FAIL'})`, distinct from TOOL_FAILED so the
 * audit trail reads intent, not malfunction (D-TL-6).
 */
export class AuthorFailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorFailError';
  }
}
