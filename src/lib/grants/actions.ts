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

/**
 * One declared parameter. `optional` (#5412, hrn:node:hadronmemory.com:specs:cor:acl:140:09, the absent-key form): a grant may leave the
 * parameter's key out, and a missing key is the parameter's absence, never a value (no `null`, `""`, `[]` or wildcard stands for it).
 * It is written only when true, so the stored `parameters` of every action without one stay byte-identical.
 */
export interface ActionParameter { name: string; type: string; refusesWildcard: boolean; optional?: true }

/**
 * #4162 (cor:acl:140:10, :06): WHO may hold a grant of an action for it to cover a WORKER's act. Ruled per action, so it is a
 * declaration of the action and never a universal of the shared check (src/lib/grants/cover.ts):
 *  - `WORKER`: the worker itself only (both boot-prompt grants, cor:agt:040:11 V50: a grant held by its role agent authorizes nothing at use);
 *  - `WORKER_OR_ROLE_AGENT`: the worker, or its role agent's grant, which reaches the agent's live workers (cor:acl:140:06, Decided);
 *  - `NO_WORKER`: a person-held grant, which reaches no agent or worker, even one the person drives (cor:acl:140:06 R5, Decided).
 */
/** #4162: the parameter types whose value is a reference to something with an id; only these can name a subject, take a list or be covered. */
export const REFERENCE_PARAMETER_TYPES: ReadonlySet<string> = new Set(['node-ref', 'secret-ref', 'worker-ref', 'memory-ref']);

export type GrantReach = 'WORKER' | 'WORKER_OR_ROLE_AGENT' | 'NO_WORKER';

/**
 * #3730 item 1: the CLOSED set of issuer-rule keys — exactly the keys `ISSUER_RULES` (./issuers.ts) maps to a gate. A key
 * outside this set has no gate, so an action naming it has no issuer and refuses everyone. Typed as a literal union so a
 * definition that names a key the registry does not provide is a compile error, and re-checked at validation because the
 * registry is code and definitions may arrive from anywhere a list can.
 */
export const ISSUER_RULE_KEYS = ['APP_SCHEDULE_ADMIN', 'APP_WEBHOOK_ADMIN', 'APP_MANAGER', 'SECRET_READ_CLIENT', 'MEMORY_READ_APPROVER', 'MEMORY_WRITE_APPROVER'] as const;
export type IssuerRuleKey = (typeof ISSUER_RULE_KEYS)[number];

export interface ActionDefinition {
  /** The dotted code, unique. */
  name: string;
  source: 'PLATFORM';
  parameters: ActionParameter[];
  /** The tool that performs it, if any. */
  tool: string | null;
  enforcement: ActionEnforcement;
  /** A closed key ({@link IssuerRuleKey}) the server maps to a gate function; never SQL or code. */
  issuerRule: IssuerRuleKey;
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
    summaryTemplate: 'Read the value of the secret {secret} of {app}, and {auto-delete}',
    // #4434 (cor:sec:060:02 R5, cor:acl:140:06): a worker holder reads through its bound worker session, and an agent holder through its
    // role agent's live workers in the client's App (readClientReveal.ts judges the reach with the shared helpers). A person holder
    // reads on the passkey page and reaches no worker; an App holder has no reveal path (S5, #4000).
    reach: 'WORKER_OR_ROLE_AGENT',
  },
  // #4855 (cor:acl:140:02, cor:agt:070:08 S4a; Holger 2026-11-22: a person-signed grant action, no wildcard): the worker dedicated to
  // manage agents ends a DARK open session of a named worker and starts that worker again, with no person in the loop. The grant names
  // the workers it covers (one `worker` parameter that takes a list, never the wildcard); a person who manages the App signs it; it
  // repeats (no count). No role is named anywhere: the holder is whichever worker the person gave the grant to, and only that worker
  // (never its role agent) may use it.
  {
    name: 'worker.session.restart', source: 'PLATFORM', tool: null, enforcement: 'SERVER', issuerRule: 'APP_MANAGER',
    parameters: [{ name: 'worker', type: 'worker-ref', refusesWildcard: true }],
    summaryTemplate: 'End a dark open session of any worker among {worker} in {app} and start that worker again',
    reach: 'WORKER', listParameters: ['worker'],
  },
  // #4000: complete signed terms, including the HTTPS path and header the signer approves.
  {
    name: 'secret.use', source: 'PLATFORM', tool: 'web_request', enforcement: 'SERVER', issuerRule: 'SECRET_READ_CLIENT',
    parameters: [
      { name: 'secret', type: 'secret-ref', refusesWildcard: true },
      { name: 'auto-delete', type: 'secret-mark', refusesWildcard: true },
      { name: 'binding-prefix', type: 'https-prefix', refusesWildcard: true },
      { name: 'binding-header', type: 'header-name', refusesWildcard: true },
    ],
    summaryTemplate: 'Use the secret {secret} of {app} at {binding-prefix} with header {binding-header}, and {auto-delete}',
    reach: 'NO_WORKER',
  },
  // #5321 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, D-2026-11-26-003; Holger 2026-11-27, both answers): read memories outside the
  // App, read only, as the App acting with no person behind it (its userless runs, and a pure key holding the grant:read scope). The one
  // `memory` parameter takes either form Holger ruled ("The grant may be for all org memories (org ADMIN and OWNER approve, create/issue
  // anyone) or the grant names one or more memories. Then owner of that memory approves."):
  //  (a) the App's OWN organization's id, a single value: its ORGANIZATION knowledge, reaching userless runs only, never a key
  //      (cor:acl:010:04); signed by an ADMIN or OWNER of that organization;
  //  (b) one or more memory ids (a single id or a list, never the wildcard): signed by whoever manages every named memory, so a grant
  //      naming memories of different managers cannot be signed by one person (one grant per manager).
  // Judged at every read, the giver's own read included (src/lib/grants/readGrant.ts). There is no `knowledge.read` (Holger: "is to
  // unspecific"). `memory.write` is below (#5404).
  // #5412 (cor:acl:140:02, the two Proposed optional parameters; cor:acl:140:09, the absent-key form): `branch`, one loc inside the ONE
  // memory form (b) names (never with form (a) or a list, the gate's decision), so the grant reads only that loc and below it; and
  // `automation`, one live schedule or webhook of the App, so the grant reaches only the userless runs whose root trigger it is, never a
  // key. Absent, each restricts nothing, and the summary writes nothing for it: a grant with neither reads, and reads as, an S1 grant.
  {
    name: 'memory.read', source: 'PLATFORM', tool: null, enforcement: 'SERVER', issuerRule: 'MEMORY_READ_APPROVER',
    parameters: [
      { name: 'memory', type: 'memory-ref', refusesWildcard: true },
      { name: 'branch', type: 'loc-prefix', refusesWildcard: true, optional: true },
      { name: 'automation', type: 'automation-ref', refusesWildcard: true, optional: true },
    ],
    summaryTemplate: 'Let {app}, acting with no person behind it, read {memory}{branch}, read only{automation}',
    reach: 'NO_WORKER', listParameters: ['memory'],
  },
  // #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, Holger 2026-11-27: "the grant should be called `memory.read` or `memory.write`";
  // its approver, "Owner of each named memory"): let the App's userless runs create and edit nodes in the memories it names, under
  // `prefix`. It replaces ruling 0083's unsigned App write grant, whose rows are deleted at deploy. `memory` is one memory id or a list,
  // never the wildcard, and never the organization (there is no org-wide write form); `prefix` is the wildcard (the whole of every named
  // memory) or one loc, allowed only when `memory` names exactly one. Signed by whoever manages every named memory (for a personal or
  // private memory, its owner). Judged at every write (src/lib/grants/writeGrant.ts); held by the grant's own App only.
  {
    name: 'memory.write', source: 'PLATFORM', tool: null, enforcement: 'SERVER', issuerRule: 'MEMORY_WRITE_APPROVER',
    parameters: [{ name: 'memory', type: 'memory-ref', refusesWildcard: true }, { name: 'prefix', type: 'loc-prefix', refusesWildcard: false }],
    summaryTemplate: 'Let {app}, acting with no person behind it, create and edit nodes in {memory} under {prefix}',
    reach: 'NO_WORKER', listParameters: ['memory'],
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
    // #3730 item 1: the registry is closed. A key that only LOOKS like one — an inherited property name ('toString',
    // '__proto__'), or a typo — is refused here, before any write; at the issuer door a plain Record lookup would answer
    // such a key with a "gate" that either never refuses (an inherited function) or is not callable.
    if (!(ISSUER_RULE_KEYS as readonly string[]).includes(a.issuerRule)) {
      throw new Error(`action ${a.name}: unknown issuerRule ${JSON.stringify(a.issuerRule)} (closed set: ${ISSUER_RULE_KEYS.join(', ')})`);
    }
    if (a.reach !== undefined && !(['WORKER', 'WORKER_OR_ROLE_AGENT', 'NO_WORKER'] as readonly string[]).includes(a.reach)) throw new Error(`action ${a.name}: unknown reach`);
    for (const n of a.listParameters ?? []) {
      const p = a.parameters.find((x) => x.name === n);
      if (!p) throw new Error(`action ${a.name}: listParameters names unknown parameter ${n}`);
      // A list on a parameter that is no reference names nothing: the shared check would refuse every act of the action, silently.
      if (!REFERENCE_PARAMETER_TYPES.has(p.type)) throw new Error(`action ${a.name}: listParameters names ${n}, whose type ${p.type} is not a reference type`);
    }
    // #5412: `optional` is exactly `true` or absent, so a stored row never carries `optional: false` (which would change the bytes of
    // every action's stored parameters), and an optional parameter must refuse the wildcard (its absence is the unrestricted form).
    for (const p of a.parameters) {
      if ('optional' in p && p.optional !== true) throw new Error(`action ${a.name}: parameter ${p.name} has optional other than true`);
      if (p.optional && !p.refusesWildcard) throw new Error(`action ${a.name}: optional parameter ${p.name} must refuse the wildcard`);
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
