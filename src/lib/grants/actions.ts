/**
 * #3668 (S1a, cor:acl:140:02): the platform's actions and the ONE writer of the `actions` table, an idempotent upsert that
 * runs at deploy (scripts/db/upsert-actions.ts, from scripts/docker-start.sh as the owner role). A change to the list is a
 * code review; no GraphQL, MCP, CLI or run-tool call writes an action, so an agent's author cannot invent one.
 *
 * #3707 (S1b): the list carries the first two actions, `schedule.create` and `webhook.create`, with the terms
 * cor:acl:140:02 states as ruled (0253, item 1). Seeding writes ACTION rows only: no holder, no grant. The upsert never
 * DELETES: a grant may name any row it ever wrote (FK RESTRICT), and what a retired action allows is not defined yet.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { summaryPlaceholders } from './summary.js';

export const ACTION_ENFORCEMENT = ['SERVER', 'CREDENTIAL', 'HARNESS_INSTRUCTION', 'RECORDED_ONLY'] as const;
export type ActionEnforcement = (typeof ACTION_ENFORCEMENT)[number];

export interface ActionParameter { name: string; type: string; refusesWildcard: boolean }

/**
 * #4162 (cor:acl:140:10, :06): WHO may hold a grant of an action for it to cover a WORKER's act. Ruled per action, so it is a
 * declaration of the action and never a universal of the shared check (src/lib/grants/cover.ts):
 *  - `WORKER`: the worker itself only (both boot-prompt grants, cor:agt:040:11 V50: a grant held by its role agent authorizes nothing at use);
 *  - `WORKER_OR_ROLE_AGENT`: the worker, or its role agent's grant, which reaches the agent's live workers (cor:acl:140:06, Decided);
 *  - `NO_WORKER`: a person-held grant, which reaches no agent or worker, even one the person drives (cor:acl:140:06 R5, Decided).
 */
/** #4162: the parameter types whose value is a reference to something with an id; only these can name a subject, take a list or be covered. */
export const REFERENCE_PARAMETER_TYPES: ReadonlySet<string> = new Set(['node-ref', 'secret-ref']);

export type GrantReach = 'WORKER' | 'WORKER_OR_ROLE_AGENT' | 'NO_WORKER';

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
  /** #4162: who may hold a grant of this action for it to cover a worker's act (see {@link GrantReach}). Absent means `WORKER`, the narrowest. Code-only: never stored or served. */
  reach?: GrantReach;
  /**
   * #4162 (cor:acl:140:10 line 4: "the action's own declaration"): the names of the parameters whose value may be a LIST of ids, a
   * grant covering an act on any member. Every other parameter takes one id only (a list names nothing). Code-only like `reach`, so
   * the stored and served parameter shape (name, type, refusesWildcard) is unchanged.
   */
  listParameters?: readonly string[];
  /** #4163 (cor:acl:140:02): a limit on uses that applies to every grant of this action. A grant's own count can only narrow it. */
  maxUses?: number;
  /** #4163: a limit on lifetime from activation, in seconds, that applies to every grant of this action. A grant's own expiry can only narrow it. */
  lifetimeSeconds?: number;
}

/** The platform's hour for a boot-prompt grant (ruling 0267, cor:agt:040:11): from activation, i.e. from the signature. */
export const BOOT_PROMPT_GRANT_LIFETIME_SECONDS = 3600;

/**
 * Each takes one parameter, the entry node, refuses a wildcard value, is enforced by the server, and is issued by whoever may
 * create one in that App themselves (`createAgentSchedule` / `createAgentWebhook`: `requireScheduleAdmin`, see ./issuers.ts).
 * Enforcement itself is #3483; until it lands the level states what the platform promises, not what a gate does today.
 */
const ENTRY_NODE: ActionParameter = { name: 'entryNode', type: 'node-ref', refusesWildcard: true };

export const PLATFORM_ACTIONS: readonly ActionDefinition[] = [
  {
    name: 'schedule.create', source: 'PLATFORM', parameters: [ENTRY_NODE], tool: null, enforcement: 'SERVER',
    issuerRule: 'APP_SCHEDULE_ADMIN', summaryTemplate: 'Create a schedule in {app} that starts at the entry node {entryNode}',
    reach: 'WORKER_OR_ROLE_AGENT', listParameters: ['entryNode'],
  },
  {
    name: 'webhook.create', source: 'PLATFORM', parameters: [ENTRY_NODE], tool: null, enforcement: 'SERVER',
    issuerRule: 'APP_WEBHOOK_ADMIN', summaryTemplate: 'Create a webhook in {app} that starts at the entry node {entryNode}',
    reach: 'WORKER_OR_ROLE_AGENT', listParameters: ['entryNode'],
  },
  // #3823 (ruling 0267, cor:agt:040:11 r8): the two boot-prompt grants. The edit names ONE source node (a single value, enforced
  // where it is spent); the batch names the compiled prompts it covers. The signer must manage the App, and what more the signer must
  // manage for the named node is judged where the grant is spent (src/lib/grants/bootPromptGrant.ts), on the node itself.
  {
    name: 'bootprompt.source.edit', source: 'PLATFORM', parameters: [{ name: 'sourceNode', type: 'node-ref', refusesWildcard: true }], tool: null,
    enforcement: 'SERVER', issuerRule: 'APP_MANAGER', summaryTemplate: 'Change the text of the boot prompt source {sourceNode} in {app}, once, within an hour',
    maxUses: 1, lifetimeSeconds: BOOT_PROMPT_GRANT_LIFETIME_SECONDS,
    reach: 'WORKER',
  },
  {
    name: 'bootprompt.compile.approve', source: 'PLATFORM', parameters: [{ name: 'compiledNode', type: 'node-ref', refusesWildcard: true }], tool: null,
    enforcement: 'SERVER', issuerRule: 'APP_MANAGER', summaryTemplate: 'Compile and approve the boot prompts {compiledNode} in {app}, any number of times within an hour',
    lifetimeSeconds: BOOT_PROMPT_GRANT_LIFETIME_SECONDS,
    reach: 'WORKER', listParameters: ['compiledNode'],
  },
  // #3998 (S3 of #3991, cor:acl:140:09 secret forms, byte review passed at checkpoint 1): reveal the value of ONE App secret. Seeded once,
  // complete: the secret as its stored id (a single value, never a name, a list or the wildcard) and the mark, exactly "keep" or "delete"
  // (the secret is deleted by the read that spends the last use). The window and the budget are the grant's own starts, expires and
  // max uses, so nothing about them is a parameter. The mark is named in the sentence ({auto-delete}), which the signing page
  // shows whole: a term the signer is not shown is not a term the signature may cover. `secret.use` is S5's and is not seeded here.
  {
    name: 'secret.reveal', source: 'PLATFORM', tool: null, enforcement: 'SERVER', issuerRule: 'SECRET_READ_CLIENT',
    parameters: [
      { name: 'secret', type: 'secret-ref', refusesWildcard: true },
      { name: 'auto-delete', type: 'secret-mark', refusesWildcard: true },
    ],
    summaryTemplate: 'Read the value of the secret {secret} of {app} and {auto-delete}',
  },
];

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
    if (a.reach !== undefined && !(['WORKER', 'WORKER_OR_ROLE_AGENT', 'NO_WORKER'] as readonly string[]).includes(a.reach)) throw new Error(`action ${a.name}: unknown reach`);
    for (const n of a.listParameters ?? []) {
      const p = a.parameters.find((x) => x.name === n);
      if (!p) throw new Error(`action ${a.name}: listParameters names unknown parameter ${n}`);
      // A list on a parameter that is no reference names nothing: the shared check would refuse every act of the action, silently.
      if (!REFERENCE_PARAMETER_TYPES.has(p.type)) throw new Error(`action ${a.name}: listParameters names ${n}, whose type ${p.type} is not a reference type`);
    }
    for (const [label, v] of [['maxUses', a.maxUses], ['lifetimeSeconds', a.lifetimeSeconds]] as const) {
      if (v !== undefined && (!Number.isSafeInteger(v) || v <= 0 || v > 2147483647)) throw new Error(`action ${a.name}: ${label} must be a positive integer`);
    }
    // #3742: a template may name {app} and its action's parameters, nothing else, so no template can ask the renderer for text it must refuse.
    const names = new Set(a.parameters.map((p) => p.name));
    if (names.has('app')) throw new Error(`action ${a.name}: a parameter named "app" would be ambiguous with {app}`);
    let placeholders: string[];
    try { placeholders = summaryPlaceholders(a.summaryTemplate); } catch (e) { throw new Error(`action ${a.name}: summaryTemplate has a malformed placeholder or brace`, { cause: e }); }
    for (const p of placeholders) {
      if (p !== 'app' && !names.has(p)) throw new Error(`action ${a.name}: summaryTemplate names unknown placeholder {${p}}`);
    }
    // The signer reads the summary, and the signature covers every value: a parameter the template never names would be a term
    // the person signs without having been shown it.
    for (const n of names) {
      if (!placeholders.includes(n)) throw new Error(`action ${a.name}: summaryTemplate never names the parameter {${n}}`);
    }
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
      INSERT INTO actions (name, source, parameters, tool, enforcement, issuer_rule, summary_template, max_uses, lifetime_seconds, created_at, updated_at)
      VALUES (${a.name}, ${a.source}, ${JSON.stringify(a.parameters)}::jsonb, ${a.tool}, ${a.enforcement}, ${a.issuerRule}, ${a.summaryTemplate},
              ${a.maxUses ?? null}::int, ${a.lifetimeSeconds ?? null}::int,
              (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT (name) DO UPDATE SET
        source = EXCLUDED.source, parameters = EXCLUDED.parameters, tool = EXCLUDED.tool, enforcement = EXCLUDED.enforcement,
        issuer_rule = EXCLUDED.issuer_rule, summary_template = EXCLUDED.summary_template,
        max_uses = EXCLUDED.max_uses, lifetime_seconds = EXCLUDED.lifetime_seconds, updated_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE (actions.source, actions.parameters, actions.tool, actions.enforcement, actions.issuer_rule, actions.summary_template, actions.max_uses, actions.lifetime_seconds)
        IS DISTINCT FROM (EXCLUDED.source, EXCLUDED.parameters, EXCLUDED.tool, EXCLUDED.enforcement, EXCLUDED.issuer_rule, EXCLUDED.summary_template, EXCLUDED.max_uses, EXCLUDED.lifetime_seconds)
      RETURNING (xmax = 0) AS inserted`);
    if (rows.length === 0) result.unchanged++;
    else if (rows[0].inserted) result.inserted++;
    else result.updated++;
  }
  return result;
}
