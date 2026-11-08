/**
 * #3668 (S1a, cor:acl:140:02): the platform's actions and the ONE writer of the `actions` table, an idempotent upsert that
 * runs at deploy (scripts/db/upsert-actions.ts, from scripts/docker-start.sh as the owner role). A change to the list is a
 * code review; no GraphQL, MCP, CLI or run-tool call writes an action, so an agent's author cannot invent one.
 *
 * The list is EMPTY in S1a. The two named actions (`schedule.create`, `webhook.create`) are seeded in a later slice, after
 * their terms are ruled; this mechanism never seeds one by itself. The upsert never DELETES: a grant may name any row it
 * ever wrote (FK RESTRICT), and what a retired action allows is not defined yet.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

export const ACTION_ENFORCEMENT = ['SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY'] as const;
export type ActionEnforcement = (typeof ACTION_ENFORCEMENT)[number];

export interface ActionParameter { name: string; type: string; refusesWildcard: boolean }

export interface ActionDefinition {
  /** The dotted code, unique. */
  name: string;
  source: 'PLATFORM';
  parameters: ActionParameter[];
  /** The tool that performs it, if any. */
  tool: string | null;
  enforcement: ActionEnforcement;
  /** A closed key the server maps to a gate function; never SQL or code. */
  issuerRule: string;
  /** The plain-language template the platform fills from the action and a grant's values only. */
  summaryTemplate: string;
}

/** EMPTY in S1a. */
export const PLATFORM_ACTIONS: readonly ActionDefinition[] = [];

export interface UpsertResult { inserted: number; updated: number; unchanged: number }

function validate(list: readonly ActionDefinition[]): void {
  const seen = new Set<string>();
  for (const a of list) {
    if (!a.name || !a.name.trim()) throw new Error('action definition needs a name');
    if (seen.has(a.name)) throw new Error(`duplicate action definition: ${a.name}`);
    seen.add(a.name);
    if (!(ACTION_ENFORCEMENT as readonly string[]).includes(a.enforcement)) throw new Error(`action ${a.name}: unknown enforcement level`);
    if (a.source !== 'PLATFORM') throw new Error(`action ${a.name}: source must be PLATFORM`);
    if (!a.issuerRule || !a.summaryTemplate) throw new Error(`action ${a.name}: issuerRule and summaryTemplate are required`);
  }
}

/**
 * Insert what is missing, update what differs, leave the rest untouched (an unchanged row writes no new tuple version and
 * keeps its `updated_at`). Rows absent from `list` are never touched. All definitions are validated before the first write.
 */
export async function upsertPlatformActions(
  client: PrismaClient | Prisma.TransactionClient, list: readonly ActionDefinition[] = PLATFORM_ACTIONS,
): Promise<UpsertResult> {
  validate(list);
  const result: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
  for (const a of list) {
    const rows = await client.$queryRaw<Array<{ inserted: boolean }>>(Prisma.sql`
      INSERT INTO actions (name, source, parameters, tool, enforcement, issuer_rule, summary_template, created_at, updated_at)
      VALUES (${a.name}, ${a.source}, ${JSON.stringify(a.parameters)}::jsonb, ${a.tool}, ${a.enforcement}, ${a.issuerRule}, ${a.summaryTemplate},
              (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT (name) DO UPDATE SET
        source = EXCLUDED.source, parameters = EXCLUDED.parameters, tool = EXCLUDED.tool, enforcement = EXCLUDED.enforcement,
        issuer_rule = EXCLUDED.issuer_rule, summary_template = EXCLUDED.summary_template, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE (actions.source, actions.parameters, actions.tool, actions.enforcement, actions.issuer_rule, actions.summary_template)
        IS DISTINCT FROM (EXCLUDED.source, EXCLUDED.parameters, EXCLUDED.tool, EXCLUDED.enforcement, EXCLUDED.issuer_rule, EXCLUDED.summary_template)
      RETURNING (xmax = 0) AS inserted`);
    if (rows.length === 0) result.unchanged++;
    else if (rows[0].inserted) result.inserted++;
    else result.updated++;
  }
  return result;
}
