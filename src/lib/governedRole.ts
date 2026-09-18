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

/** The closed governed subset of `Node.role` plus the capability-gated kind. */
export type GovernedKind = 'task' | 'review' | 'spec';

/** How strong a kind's gate actually is — carried so nobody has to infer it. */
export type GateStrength = 'capability' | 'security' | 'diligence';

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
  },
  {
    kind: 'review',
    signal: { field: 'role', value: 'review' },
    strength: 'security',
    doors: { create: 'createReviewNode', update: 'updateReviewNode' },
  },
  {
    kind: 'spec',
    signal: { field: 'role', value: 'spec' },
    strength: 'diligence',
    doors: { create: 'createSpecNode', update: 'updateSpecNode' },
  },
] as const;

/** The governed `role` values, for the SDL description and for callers that need the set. */
export const GOVERNED_ROLES: readonly string[] = GOVERNED_KINDS.flatMap((e) =>
  e.signal.field === 'role' ? [e.signal.value] : [],
);

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
      : state.role === entry.signal.value,
  );
}

/** The typed refusal — `extensions.code: 'ROLE_GOVERNED'`, naming the door that can act. */
export class RoleGovernedError extends GraphQLError {
  constructor(
    public readonly entry: GovernedKindEntry,
    public readonly op: 'create' | 'update',
  ) {
    const door = entry.doors[op];
    super(
      entry.signal.field === 'isRunnable'
        ? `This write would produce a RUNNABLE node, which only ${door} may ${op}. Authoring something the platform will execute is not the same act as writing prose; the generic node surface does not reach it.`
        : `This write would produce a node with role "${entry.signal.value}", which only ${door} may ${op}. The generic node surface does not reach it.`,
      {
        extensions: {
          code: 'ROLE_GOVERNED',
          kind: entry.kind,
          strength: entry.strength,
          door,
          op,
        },
      },
    );
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
  const affected = new Map<GovernedKind, GovernedKindEntry>();
  for (const e of governedKindsOf(prior ?? {})) affected.set(e.kind, e);
  for (const e of governedKindsOf(next)) affected.set(e.kind, e);
  for (const entry of affected.values()) {
    if (entry.kind === owns) continue;
    throw new RoleGovernedError(entry, op);
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
