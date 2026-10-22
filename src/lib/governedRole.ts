/**
 * #1201 — the governed-kind register and the gate that keys on it.
 *
 * ## The rule
 *
 * A node's KIND is a property of the WRITE, not of the address it lands at.
 * `Node.role` is an OPEN string an agent builder may set to anything; a small
 * CLOSED subset is *governed*, and a write that would PRODUCE a governed node
 * must come through that kind's own door. The generic node surface — the one
 * `hadron_create_node` and `hadron_update_node` reach — is refused.
 *
 * The field is open so it stays useful; the governed subset is closed so the
 * gate is never caller-defined. `role: 'weather-widget'` does nothing at all.
 *
 * ## THE THREE ENTRIES ARE NOT EQUALLY STRONG, and that is stated here rather
 * than left to a later reader, because every wrong turn on this feature came
 * from someone assuming a mechanism was stronger than it is.
 *
 * | kind   | gate keys on  | strength    |
 * |--------|---------------|-------------|
 * | task   | `isRunnable`  | CAPABILITY  |
 * | review | `role`        | SECURITY    |
 * | spec   | `role`        | DILIGENCE   |
 *
 * **task — capability, and the only entry whose gate cannot be evaded by
 * omission.** A label is caller-set and freely dropped; `isRunnable` is the
 * thing that makes a node RUN. Omit it and the node does not run, so evasion is
 * self-defeating. That is why the security case keys here and not on a label
 * (@Holger: *"The platform still needs to do additional checks beyond
 * `Node.role` when there is a security concern. And `isRunnable` is the right
 * check."*). The threat is #1202's: a memory shared with someone who authors a
 * runnable node that reads the owner's data when the OWNER runs it.
 *
 * **review — security, and not coding-centric.** Any work performed can be
 * reviewed, and a review may be a SAFETY CHECK. So an attacker can (1) modify
 * the work assignment and (2) remove the reviews meant to catch that. Omitting
 * the label is self-defeating in its own way — an unlabelled check is invisible
 * to the review tooling, so it is not a check.
 *
 * **spec — diligence only, and the weakest of the three by design.** It
 * guarantees a spec node was authored by the spec tool (#1152, and the corpus
 * discipline that rests on it). It does NOT claim a determined caller could not
 * author one another way: the label is free to omit, a citation resolves with
 * or without it, so evading buys an unmarked node at a citation loc. @Holger
 * ruled specs are not much of a security concern, and the destructive half is
 * already closed by #1182/#1184 (`createNode` is mint-or-refuse and race-safe).
 *
 * ## What this replaces
 *
 * `Memory.protectedLocs` (#1190, one day old) governed by ADDRESS. That axis
 * was wrong — a task node is dangerous because it is runnable, not because of
 * where it sits — and its justification (extensibility as data, no code change
 * per corpus) died with kind-specific doors, which need a new field per kind
 * anyway. Address-based protection remains a CHANNEL concept only
 * (`protectedLoc.ts`), where it is about an operation owning an address rather
 * than about what a node is.
 *
 * ## What is deliberately NOT here
 *
 * Every identity question — who may author a governed node, and who may CHANGE
 * or CLEAR a governed role — is #1202. This module answers *"is this caller the
 * right door?"* and nothing about *"is this caller the right principal?"*. A
 * door refuses the wrong TOOL, never the wrong PRINCIPAL: if you can write the
 * memory, you can call the door.
 */

import { GraphQLError } from 'graphql';
import type { NodeRoleRule, Prisma, PrismaClient } from '../generated/prisma/index.js';

/** The closed governed subset of `Node.role` plus the capability-gated kind. */
export type GovernedKind = 'task' | 'review' | 'spec' | 'decision';

/** How strong a kind's gate actually is — carried so nobody has to infer it. */
export type GateStrength = 'capability' | 'security' | 'diligence' | 'authority';

export interface GovernedKindEntry {
  kind: GovernedKind;
  /**
   * What makes a node this kind. `role` matches `Node.role`; `isRunnable`
   * matches the capability column and ignores the label entirely.
   */
  signal: { field: 'role'; value: string } | { field: 'isRunnable' };
  strength: GateStrength;
  /** The mutations that may produce this kind, named in the refusal. */
  doors: { create: string; update: string };
  /**
   * The MCP tools that are this kind's doors, or null when NO MCP tool writes
   * it (a spec, by design). Named in the refusal so an agent is sent somewhere
   * it can actually go (#1301): the GraphQL mutation above is not an MCP tool.
   */
  mcpDoors: { create: string; update: string } | null;
  /** Extra CLI guidance for this kind, beyond `hadron node create|update`. */
  cliNote?: string;
  /**
   * #1641 — the kind is written only by its own purpose-built OPERATIONS, one
   * per state change, never by a generic-shaped create/update pair: no door
   * mutation is generated for it, and a refusal names no replay route (no
   * door takes a generic node write). `doors` then names its ask and amend
   * operations, for tooling that reads `extensions.door`.
   */
  operationsOnly?: true;
}

/**
 * A MERGE surface: the generic `updateNodeData` / `updateNodeProperties`. No
 * governed door merges; each door REPLACES the field (#1301). A refusal from a
 * merge says so, rather than sending its reader to a door that would silently
 * drop every key they did not resend.
 */
export type GovernedMerge = 'data' | 'properties';

/**
 * WHICH operation was refused, so the refusal offers only routes that perform
 * THAT operation (@codex, PR #1305). A node write can be retried through the
 * kind's door; a revision restore has no door at all (#1204); a bulk merge or
 * extract is not completed by editing one node. Omitted means "offer no
 * route": the safe default for any caller not listed here.
 */
export type GovernedContext = 'node-write' | 'restore' | 'node-restore' | 'bulk';

export interface GovernedRefusalOptions {
  merge?: GovernedMerge;
  context?: GovernedContext;
  /**
   * Every governed kind the node matches, when there is more than one (a
   * runnable review). Each door is exempt from its OWN kind only, so no single
   * door can write such a node, and naming one would name a route that fails
   * (@copilot + @codex, PR #1305).
   */
  kinds?: readonly GovernedKindEntry[];
  /**
   * Whether the refused call could be replayed through the door of `kind`.
   * Asked by the error, because only the gate knows WHICH kind it is refusing;
   * a surface whose doors carry fewer fields than its generic writer (MCP)
   * supplies it, and `false` withdraws every route (@copilot + @codex, #1305).
   */
  canReplay?: (kind: GovernedKind) => boolean;
  /**
   * The surface the refused call arrived on. A route is only named on the
   * surface that can replay the call (@codex, PR #1305 round 7): the MCP door
   * tools carry fewer fields than the GraphQL input, so a GraphQL refusal
   * names the GraphQL door and the CLI route, never an MCP tool. Default:
   * `graphql`.
   */
  surface?: 'graphql' | 'mcp';
}

/**
 * THE REGISTER. Small on purpose — @Holger: *"We have < 5 types of protected
 * nodes. Giving them each the door they need is the simplest path. This does
 * not have to scale to 100."* So: no plugin mechanism, no dynamic registration,
 * no generic fallback door. Adding a kind is a code change, and that is the
 * accepted cost.
 */
export const GOVERNED_KINDS: readonly GovernedKindEntry[] = [
  {
    kind: 'task',
    signal: { field: 'isRunnable' },
    strength: 'capability',
    doors: { create: 'createTaskNode', update: 'updateTaskNode' },
    mcpDoors: { create: 'hadron_create_task', update: 'hadron_update_task' },
  },
  {
    kind: 'review',
    signal: { field: 'role', value: 'review' },
    strength: 'security',
    doors: { create: 'createReviewNode', update: 'updateReviewNode' },
    mcpDoors: { create: 'hadron_create_review', update: 'hadron_update_review' },
  },
  {
    kind: 'spec',
    signal: { field: 'role', value: 'spec' },
    strength: 'diligence',
    doors: { create: 'createSpecNode', update: 'updateSpecNode' },
    // By design (#1201): an agent's node surface cannot author platform law.
    mcpDoors: null,
    cliNote: '`hadron spec new` and `hadron spec edit` are the spec commands',
  },
  {
    // #1641 — a human decision (`decision`) and its log (`decision.log`), one
    // family. AUTHORITY: a decision can carry an authorization, which is
    // stronger than a review. Its content is server-rendered from structured
    // data, so the approval hash covers exactly what the decider answered; the
    // generic surface would let content and data drift apart.
    kind: 'decision',
    signal: { field: 'role', value: 'decision' },
    strength: 'authority',
    doors: { create: 'askDecision', update: 'amendDecision' },
    mcpDoors: null,
    cliNote: 'decisions are written only through the decision operations (askDecision, amendDecision, withdrawDecision, …)',
    operationsOnly: true,
  },
] as const;

/** The governed `role` values, for the SDL description and for callers that need the set. */
export const GOVERNED_ROLES: readonly string[] = GOVERNED_KINDS.flatMap((e) =>
  e.signal.field === 'role' ? [e.signal.value] : [],
);

/** Maximum stored length of a {@link NodeRoleRule} lookup key (#1322). */
export const RULE_ROLE_MAX_LENGTH = 64;

/**
 * Grammar for role RULE KEYS, not for `Node.role` itself.
 *
 * A node role deliberately remains an open string. A rule key is different:
 * the platform resolves it one dot-delimited segment at a time, so accepting
 * empty/mixed-case/punctuation segments would make the lookup ambiguous to
 * clients. Each segment is lower-case alphanumeric plus internal dashes; the
 * whole key is bounded to 64 characters.
 */
const RULE_ROLE_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

/** Whether `role` is a valid `NodeRoleRule.role` / template-rule key. */
export function isValidRuleRole(role: string): boolean {
  return role.length > 0 && role.length <= RULE_ROLE_MAX_LENGTH && RULE_ROLE_RE.test(role);
}

/**
 * Why a rule key failed, as a structured field a client can branch on
 * (hadron-cli#716 Q9 — the code and this field are the contract, never the
 * prose). Deterministic priority, one reason per key: EMPTY for the literal
 * empty string, TOO_LONG past the cap, otherwise BAD_SEGMENT. Nothing is
 * repaired first: whitespace-only is BAD_SEGMENT, not EMPTY, because a key is
 * never trimmed or lower-cased into validity.
 */
export type InvalidNodeRoleReason = 'EMPTY' | 'TOO_LONG' | 'BAD_SEGMENT';

export function invalidRuleRoleReason(role: string): InvalidNodeRoleReason | null {
  if (role === '') return 'EMPTY';
  if (role.length > RULE_ROLE_MAX_LENGTH) return 'TOO_LONG';
  return RULE_ROLE_RE.test(role) ? null : 'BAD_SEGMENT';
}

/** Typed rule-key refusal for the config mutation surface that consumes this helper. */
export class InvalidNodeRoleError extends GraphQLError {
  constructor(role: string, reason: InvalidNodeRoleReason = invalidRuleRoleReason(role) ?? 'BAD_SEGMENT') {
    super(
      `Invalid node-role rule key "${role}": use 1-${RULE_ROLE_MAX_LENGTH} characters as ` +
        'lower-case letter/digit/dash segments joined by dots (for example "spec.rule").',
      { extensions: { code: 'INVALID_NODE_ROLE', role, reason, maxLength: RULE_ROLE_MAX_LENGTH } },
    );
    this.name = 'InvalidNodeRoleError';
  }
}

/** Validate a stored rule key while leaving arbitrary `Node.role` values untouched. */
export function assertValidRuleRole(role: string): void {
  const reason = invalidRuleRoleReason(role);
  if (reason !== null) throw new InvalidNodeRoleError(role, reason);
}

/**
 * `role` is `base` or one of its dotted descendants.
 *
 * The explicit dot boundary is load-bearing: `spec` matches `spec.rule`, but
 * never `special` or `specification` (#1322).
 */
export function roleIsOrDescendsFrom(role: string | null | undefined, base: string): boolean {
  return role === base || role?.startsWith(`${base}.`) === true;
}

/**
 * Prisma predicates for every governed role family. Kept beside the in-memory
 * predicate so bulk SQL/Prisma probes cannot drift back to exact-only matching.
 */
export function governedRoleWhereClauses(): Array<
  { role: string } | { role: { startsWith: string } }
> {
  return GOVERNED_ROLES.flatMap((role) => [
    { role },
    { role: { startsWith: `${role}.` } },
  ]);
}

/** Most-specific-first lookup candidates for an arbitrary open node role. */
export function roleRuleCandidates(role: string): string[] {
  if (role.length === 0) return [];
  const candidates: string[] = [];
  let candidate = role;
  while (candidate.length > 0) {
    candidates.push(candidate);
    const dot = candidate.lastIndexOf('.');
    if (dot < 0) break;
    candidate = candidate.slice(0, dot);
  }
  return candidates;
}

/**
 * What a node role resolves to in a config (#1322 lookup, #1325 H1).
 *
 * A DISCRIMINATED result rather than `T | null`, so no enforcement consumer
 * (#1328/#1330) can mistake a strict refusal for "the parent's rule applies"
 * or for "no rule, the role is free" — the compiler makes it handle all three
 * (#1345 review, @copilot).
 *   - `RULE`: the nearest enabled rule governs the role.
 *   - `UNDECLARED_UNDER_STRICT`: Holger's H1 — the nearest enabled ancestor
 *     sets `strictSubRoles`, and the role is not declared, so it is REFUSED;
 *     `ancestor` is the strict rule, for the refusal message.
 *   - `NONE`: no rule applies; the role is free.
 */
export type NodeRoleResolution<T> =
  | { kind: 'RULE'; rule: T }
  | { kind: 'UNDECLARED_UNDER_STRICT'; ancestor: T }
  | { kind: 'NONE' };

const NO_RULE = { kind: 'NONE' } as const;

/**
 * Resolve a node role against a config's rules.
 *
 * An exact enabled row wins. Otherwise the lookup removes one dot segment at a
 * time (`spec.rule.detail` -> `spec.rule` -> `spec`). Disabled rows are skipped
 * and the walk continues outward. The INPUT role is intentionally not grammar-
 * validated: `Node.role` is open, while every stored rule key is validated at
 * its own write boundary.
 *
 * Strict sub-roles (H1): a role is DECLARED when the config has a row for it,
 * enabled or not (the rows are the declared-sub-role list). When the walk
 * lands on an ANCESTOR whose `strictSubRoles` is set and the role itself is
 * undeclared, the answer is `UNDECLARED_UNDER_STRICT`, never that ancestor's
 * rule. Strictness is read from the enabled rule the walk reaches: a disabled
 * rule governs nothing, strictness included.
 */
export function resolveNodeRoleRule<T extends { role: string; enabled: boolean; strictSubRoles?: boolean }>(
  role: string | null | undefined,
  rules: readonly T[],
): NodeRoleResolution<T> {
  if (!role) return NO_RULE;
  const declared = new Set(rules.map((rule) => rule.role));
  const enabledByRole = new Map(
    rules.filter((rule) => rule.enabled).map((rule) => [rule.role, rule] as const),
  );
  for (const candidate of roleRuleCandidates(role)) {
    const rule = enabledByRole.get(candidate);
    if (!rule) continue;
    // No `candidate !== role` test is needed: the exact role, if it has a row, is declared.
    if (rule.strictSubRoles === true && !declared.has(role)) {
      return { kind: 'UNDECLARED_UNDER_STRICT', ancestor: rule };
    }
    return { kind: 'RULE', rule };
  }
  return NO_RULE;
}

/**
 * Config-backed form of {@link resolveNodeRoleRule} for write enforcement.
 *
 * An absent `MemoryConfig` is the empty rulebook (#1325). The relation is
 * loaded as one bounded set because a config has few rules; the actual choice
 * stays in the pure helper so callers and tests share one lookup contract.
 */
export async function resolveMemoryNodeRoleRule(
  db: Pick<PrismaClient, 'memoryConfig'> | Pick<Prisma.TransactionClient, 'memoryConfig'>,
  memoryId: string,
  role: string | null | undefined,
): Promise<NodeRoleResolution<NodeRoleRule>> {
  if (!role) return NO_RULE;
  const config = await db.memoryConfig.findUnique({
    where: { memoryId },
    include: { rules: true },
  });
  return resolveNodeRoleRule(role, config?.rules ?? []);
}

/**
 * The post-write state of a node, as far as this gate cares. Both fields are
 * the MERGED result — what the row will look like after the write lands — never
 * what the write declared.
 */
export interface GovernedState {
  role?: string | null;
  isRunnable?: boolean | null;
}

/**
 * Which governed kinds a resulting node matches. Usually zero; a node may match
 * more than one (a runnable review is both).
 */
export function governedKindsOf(state: GovernedState): GovernedKindEntry[] {
  return GOVERNED_KINDS.filter((entry) =>
    entry.signal.field === 'isRunnable'
      ? state.isRunnable === true
      : roleIsOrDescendsFrom(state.role, entry.signal.value),
  );
}

/**
 * WHY a write is refused, which is not one thing since the gate went
 * before-union-after. Carried so the message can be accurate: a refusal that
 * says a write "would produce" a governed node is plainly wrong when the write
 * was CLEARING one (@copilot, PR #1203) — `updateNode(role: null)` leaves a
 * node that is explicitly not a review, and being told otherwise sends the
 * reader looking for a node state that does not exist.
 */
export type GovernedRefusal = 'produces' | 'removes' | 'edits';

/** The typed refusal — `extensions.code: 'ROLE_GOVERNED'`, naming the door that can act. */
/**
 * #1330 / #1400 review — the per-memory lock between node writes that judge a
 * role (SHARED, so they never block each other) and changes to that memory's
 * rulebook (EXCLUSIVE). An advisory lock rather than a row lock because it
 * must exist before the config row does: a node write reading "no rules" and a
 * first rule write materializing the config have no row in common. Keyed on
 * the memory, in the two-key form the dashboard lock uses, released at commit.
 *
 * ORDER: rule writes take it LAST, after their node and rule row locks (in
 * `materializeConfig` / `touchConfig`); node writes take it after their own
 * node locks. So no transaction waits on a row while holding this lock.
 */
export async function lockMemoryConfigShared(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, memoryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('memory-config'), hashtext(${memoryId}))`;
}

export async function lockMemoryConfigExclusive(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, memoryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('memory-config'), hashtext(${memoryId}))`;
}

/**
 * #1330 — a write assigned a sub-role that a STRICT parent rule does not
 * declare (Holger's H1: `strictSubRoles` refuses undeclared sub-roles under
 * that parent; unrelated roles stay free).
 */
export class RoleNotDeclaredError extends GraphQLError {
  constructor(role: string, strictParent: string) {
    super(
      `Role "${role}" is not declared in this memory's config, and its parent role "${strictParent}" allows only declared sub-roles (strictSubRoles). Use a declared sub-role, or ask a manager of the memory to declare it.`,
      { extensions: { code: 'ROLE_NOT_DECLARED', role, strictParent } },
    );
    this.name = 'RoleNotDeclaredError';
  }
}

/**
 * #1330 — the H1 strict-sub-role refusal at the shared write boundary, called
 * by `writeNodeCore` inside its write transaction.
 *
 * Judged only when the write ASSIGNS a role, i.e. sets one that differs from
 * the node's prior role. An existing node that already carries a now-undeclared
 * role is not refused for an unrelated edit (no retroactive invalidation, per
 * the issue), and a role is never assigned or derived here.
 *
 * Exempt: a node that is runnable after the write, and a platform write, which
 * only server code can claim (a function argument, never client input).
 *
 * The memory's config lock is taken SHARED first (`lockMemoryConfigShared`).
 * Every rule write takes it EXCLUSIVELY, including the one that first
 * materializes the config, so a concurrent strictness change serializes
 * against this check rather than racing it. That holds even when the memory
 * has no config row yet, which a row lock could not cover (#1400 review).
 */
export async function assertRoleDeclaredForWrite(
  tx: Prisma.TransactionClient,
  memoryId: string,
  write: RoleAssignment,
  opts: { platformWrite?: boolean } = {},
): Promise<void> {
  const strictParent = await strictParentRefusingRole(tx, memoryId, write, opts);
  if (strictParent !== null) throw new RoleNotDeclaredError(write.role!, strictParent);
}

export interface RoleAssignment {
  role: string | null | undefined;
  priorRole: string | null | undefined;
  runnableAfter: boolean | null | undefined;
}

/**
 * The same judgement as `assertRoleDeclaredForWrite`, answered rather than
 * thrown: the strict parent that refuses the write, or null when it may
 * proceed. For a caller that must skip a refused item and keep going, which
 * git sync does per file (Holger, #1330). Same exemptions and the same config
 * lock, so the two can never disagree.
 */
export async function strictParentRefusingRole(
  tx: Prisma.TransactionClient,
  memoryId: string,
  write: RoleAssignment,
  opts: { platformWrite?: boolean } = {},
): Promise<string | null> {
  const role = write.role;
  if (!role || role === (write.priorRole ?? null)) return null;
  if (write.runnableAfter === true || opts.platformWrite === true) return null;
  await lockMemoryConfigShared(tx, memoryId);
  const resolution = await resolveMemoryNodeRoleRule(tx, memoryId, role);
  return resolution.kind === 'UNDECLARED_UNDER_STRICT' ? resolution.ancestor.role : null;
}

export class RoleGovernedError extends GraphQLError {
  constructor(
    public readonly entry: GovernedKindEntry,
    public readonly op: 'create' | 'update',
    public readonly refusal: GovernedRefusal = 'produces',
    opts: GovernedRefusalOptions = {},
  ) {
    const { merge, context, kinds, canReplay, surface = 'graphql' } = opts;
    const door = entry.doors[op];
    const mcpDoor = entry.mcpDoors?.[op] ?? null;
    const subject =
      entry.signal.field === 'isRunnable'
        ? 'a RUNNABLE node'
        : // #1322: governance is by FAMILY, so name it — a refusal of
          // `review.security` must not claim the node's role is "review"
          // (@copilot, #1345 review). Routing metadata keeps the base kind.
          `a node with a "${entry.signal.value}"-family role ("${entry.signal.value}" or a dotted "${entry.signal.value}.*")`;
    const act =
      refusal === 'produces'
        ? `This write would produce ${subject}`
        : refusal === 'removes'
          ? `This write would REMOVE the marker that makes this ${subject} — un-governing it`
          : `This write edits ${subject}`;
    const tail =
      entry.signal.field === 'isRunnable'
        ? 'Authoring or retiring something the platform will execute is not the same act as writing prose; the generic node surface does not reach it.'
        : 'The generic node surface does not reach it.';
    // #1301: name a route on EVERY surface the refusal can reach, because the
    // GraphQL mutation alone is a door most readers cannot open. A CLI user is
    // routed by `hadron node create|update` without asking; an agent needs the
    // MCP tool, or to be told plainly that there is none.
    const kindWord = entry.kind === 'task' ? 'runnable' : entry.kind;
    const cli = `From the CLI, \`hadron node ${op}\` routes to it by itself${entry.cliNote ? `; ${entry.cliNote}` : ''}.`;
    const mcp = mcpDoor
      ? `Over MCP, use ${mcpDoor}.`
      : `No MCP tool writes a ${kindWord} node.`;
    const base = `${act}, which only ${door} may ${op}. ${tail}`;
    const multi = kinds && kinds.length > 1 ? kinds : null;
    // Whether ONE door, reached from the CLI or MCP, can perform exactly the
    // refused write. Not for a multi-kind node (every door fails on the other
    // kind), not outside a node write, and not for a CREATE that un-governs a
    // node it resurrects: the MCP create doors force the signal back ON, and
    // `hadron node create` routes by the input, which here names no kind
    // (@codex, PR #1305). Where false, no route is offered in the prose OR in
    // `extensions.mcpDoor`: a client routing from extensions must not be sent
    // where the message declined to send a reader.
    const routable =
      !entry.operationsOnly &&
      context === 'node-write' &&
      !multi &&
      !(op === 'create' && refusal === 'removes') &&
      (canReplay?.(entry.kind) ?? true);
    const onMcp = surface === 'mcp';
    // RESTORE first: whatever kinds the node carries, the reason nothing can
    // do it is that no door restores (@copilot, PR #1305 round 12).
    const message = context === 'node-restore'
      ? `This node is governed (${entry.kind}); generic restore cannot restore it. Its deletion state is unchanged.`
      : context === 'restore'
      ? // Not `base`: "only updateX may update" is not a route to a RESTORE.
        `${act}, and no door restores a revision: a governed node's history cannot be restored through any surface yet (tracked with deletes in #1204). ${tail}`
      : multi
        ? // No single door owns every kind the node carries, so none can write it.
          `${act}, and the node is governed as more than one kind (${multi.map((k) => k.kind).join(' and ')}). ` +
          `Each door is exempt from its own kind only (${multi.map((k) => k.doors[op]).join(', ')}), so no current route can write it. ${tail}`
        : routable && merge
          ? // A merge cannot be redirected to the door as-is: the door REPLACES.
            `This ${merge} MERGE edits ${subject}, and no door merges: ${door} REPLACES ${merge} instead, so send the whole object, including the keys it already has. ` +
            `From the CLI, \`hadron node update <ref> --${merge} '<object>'\` routes to ${door} by itself.` +
            // An MCP merge arrives by delegation (Context.transport); the MCP
            // doors take a whole ${merge} object, so they replay a replace.
            (onMcp ? (mcpDoor ? ` Over MCP, pass the whole ${merge} object to ${mcpDoor}.` : ` No MCP tool writes a ${kindWord} node.`) : '')
          : routable
            ? `${base} ${cli}${onMcp ? ` ${mcp}` : ''}`
            : // No route for THIS operation: name no door as if it were one
              // (@copilot, PR #1305 round 7). `extensions.door` still says
              // which door governs the kind, for tooling that wants it.
              `${act}. ${tail} There is no route to suggest for this operation.`;
    super(message, {
      extensions: {
        code: 'ROLE_GOVERNED',
        kind: entry.kind,
        strength: entry.strength,
        door: context === 'node-restore' ? null : door,
        // A route only where the operation can replay through it. A deleted-node
        // restore names no update door, in metadata as well as in prose.
        mcpDoor: routable && onMcp ? mcpDoor : null,
        op: context === 'node-restore' ? 'restore' : op,
        refusal,
        ...(merge ? { merge } : {}),
        ...(multi ? { kinds: multi.map((k) => k.kind) } : {}),
      },
    });
    this.name = 'RoleGovernedError';
  }
}

/**
 * Refuse a generic write that touches governance — one that would PRODUCE a
 * governed node, or one against a node that ALREADY is one.
 *
 * ## The resulting state is the whole point
 *
 * `state` must be the MERGED post-write state, never the input. A gate reading
 * only what a write DECLARES is evaded in two legal steps: create a node with
 * no `isRunnable`, then set `isRunnable: true` in a second generic update
 * against a node that was not governed when it was written. Neither step
 * declares a governed node; the pair produces one.
 *
 * It also means an UPDATE to an existing governed node is gated even when the
 * update touches neither signal — editing a review node's body still produces a
 * review node, so it still needs the review door. That is intended: the point
 * is that a safety check cannot be rewritten through the generic surface.
 *
 * ## `owns` is a kind, never a boolean
 *
 * A door exempts itself from its OWN kind and stays subject to every other.
 * PR #1190 shipped a single boolean bypass and it let the authoring door write
 * under a Channel address and forge chat authorship (@codex + @copilot, both
 * P1). A node matching two kinds needs the caller to own both — the task door
 * cannot mint a runnable review.
 *
 * @param state the merged post-write state (role + isRunnable).
 * @param op    which door would be named in the refusal.
 * @param owns  the kind this caller is the door for, if any. Every generic
 *              writer omits it and is refused — the safe default.
 */
export function assertGovernedWrite(
  prior: GovernedState | null | undefined,
  next: GovernedState,
  op: 'create' | 'update',
  owns?: GovernedKind,
  opts: Omit<GovernedRefusalOptions, 'kinds'> = {},
): void {
  // BEFORE **union** AFTER, and the union is the whole correction.
  //
  // Checking only the result let the generic surface UN-GOVERN a node in one
  // call: `updateNode(role: null)` cleared a review, `isRunnable: false`
  // cleared a task, and both succeeded — measured, not feared. The resulting
  // state is ungoverned, so a result-only gate sees an ordinary write and the
  // safety check simply evaporates. That is the escalation #1202 describes,
  // except #1202 assumes the DOOR was required to reach it; it was not.
  //
  // Requiring the kind's door to REMOVE its own marker is a routing rule, so it
  // belongs here. WHO may then do it through that door is #1202's question and
  // is deliberately still unanswered.
  const before = new Set(governedKindsOf(prior ?? {}).map((e) => e.kind));
  const after = new Set(governedKindsOf(next).map((e) => e.kind));
  const affected = new Map<GovernedKind, GovernedKindEntry>();
  for (const e of [...governedKindsOf(prior ?? {}), ...governedKindsOf(next)]) {
    affected.set(e.kind, e);
  }
  for (const entry of affected.values()) {
    if (entry.kind === owns) continue;
    const refusal: GovernedRefusal = !before.has(entry.kind)
      ? 'produces'
      : !after.has(entry.kind)
        ? 'removes'
        : 'edits';
    throw new RoleGovernedError(entry, op, refusal, {
      ...opts,
      ...(affected.size > 1 ? { kinds: [...affected.values()] } : {}),
    });
  }
}

/**
 * The merged post-write state for an UPDATE, applying this repo's partial-update
 * semantics (D4): an omitted field preserves, an explicit null clears.
 *
 * Kept here rather than at each call site because there are several write
 * surfaces and the merge is exactly the part that is easy to get subtly wrong —
 * `undefined` and `null` mean different things and a `??` chain collapses them.
 */
export function mergedGovernedState(
  existing: GovernedState | null | undefined,
  input: GovernedState,
): GovernedState {
  return {
    role: input.role === undefined ? (existing?.role ?? null) : input.role,
    isRunnable:
      input.isRunnable === undefined ? (existing?.isRunnable ?? null) : input.isRunnable,
  };
}
