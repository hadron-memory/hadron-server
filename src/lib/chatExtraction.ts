/**
 * Where a chat's extracted data is filed (#910).
 *
 * **The bug this exists to fix.** Extraction used to merge every value into
 * one memory-level `data` node — the Mustache variable bag that
 * `compileTemplate` reads and that routing conditions evaluate against. That
 * is coherent for a single-human memory. It is not for an app-class one:
 * every chat there is a group chat (a chat has no ACL of its own, so read and
 * write both fall through the host memory's per-class rules —
 * `cor:acl:030:01`), several members hold separate conversations in the same
 * memory, and one un-namespaced bag cannot say *whose* `industry` it holds.
 * Member A's answer became the value compiled into member B's prompt and an
 * operand of B's routing conditions. Nothing errored; B just got a subtly
 * wrong conversation.
 *
 * **The prefix already existed.** `extractionSpec[].field` has always been
 * documented as dotted (`{ "memory.name": "Alex Chen" }`), but
 * `buildRespondToolSchema` took `field.split('.').pop()` and discarded the
 * rest, so the prefix meant nothing and everything landed in the memory bag.
 * This module gives it meaning. Nothing new has to be authored: a spec that
 * already says `memory.industry` keeps behaving exactly as before.
 *
 * **Scope follows purpose.** The question an author is answering with the
 * prefix is "does anything outside this conversation need to read it?":
 *
 *   - `memory.` — genuinely memory-wide variables, shared by everyone in the
 *     memory. The pre-#910 behavior, now opt-in rather than the default.
 *   - `chat.`   — values about THIS conversation.
 *   - `user.`   — facts about the person who spoke, filed under them alone.
 *     Follows the person across chats in that memory rather than the
 *     conversation, because that is what a fact about someone is.
 *   - `stage.`  — values scoped to the stage the conversation is in, stored
 *     in the TARGET memory (never the authored script, which is read-only
 *     during a chat per `cor:cht:010:02`).
 *
 * An unprefixed field defaults to `chat`. Defaulting to `memory` would have
 * preserved the bug for every chatbot that never adopts the syntax, which is
 * the wrong direction for a default to fail in.
 */

/** The destinations a v1 extraction spec may name. */
export const EXTRACTION_DESTINATIONS = ['memory', 'chat', 'user', 'stage'] as const;

export type ExtractionDestination = (typeof EXTRACTION_DESTINATIONS)[number];

/**
 * Where an unprefixed field goes.
 *
 * Conversation-scoped, deliberately: it is the choice that cannot leak one
 * participant's answer into another's prompt, so an author who declares
 * nothing gets the safe behavior rather than the historical one.
 */
export const DEFAULT_EXTRACTION_DESTINATION: ExtractionDestination = 'chat';

/**
 * Sub-key holding extracted values on a chat or stage node.
 *
 * Never the node's top level: a chat root's `data` already carries `scope`,
 * `stageName`, `messageCount` and friends, and extraction keys are chosen by
 * the MODEL — an extracted field called `scope` merged at the top level would
 * corrupt the chat's scope invariant.
 */
export const EXTRACTED_SUBKEY = 'extracted';

/**
 * Sub-key on the memory-level `data` node holding per-user buckets, keyed by
 * user id: `data.users[<userId>][<field>]`.
 *
 * Per-user values live in the MEMORY node rather than the chat so that a fact
 * about someone outlives the conversation it was learned in — which is what
 * the memory-level bag was quietly providing before, and worth keeping once
 * it is attributed.
 */
export const USERS_SUBKEY = 'users';

function isDestination(value: string): value is ExtractionDestination {
  return (EXTRACTION_DESTINATIONS as readonly string[]).includes(value);
}

export interface ParsedExtractionField {
  destination: ExtractionDestination;
  /** The field name as the model returns it — always the last segment. */
  name: string;
}

/**
 * Split a spec's `field` into its destination and the name the model answers
 * with.
 *
 * The name is ALWAYS the last dotted segment, matching what
 * `buildRespondToolSchema` puts in the tool schema — the two must agree or a
 * routed value would be looked up under a key the model never returned. Only
 * the FIRST segment is consulted for a destination, and only when it is one
 * of the known words; anything else (`foo.industry`, a bare `industry`) keeps
 * the default. An unknown prefix is therefore inert rather than an error,
 * which matters because these strings cross a JSON boundary from authored
 * node data.
 */
export function parseExtractionField(field: string): ParsedExtractionField {
  const segments = field.split('.');
  const name = segments.pop() ?? field;
  const destination =
    segments.length > 0 && isDestination(segments[0])
      ? segments[0]
      : DEFAULT_EXTRACTION_DESTINATION;
  return { destination, name };
}

/** Extraction-spec entries, as carried on `Node.data.extractionSpec`. */
export interface ExtractionFieldSpec {
  field: string;
}

export type RoutedExtraction = Record<ExtractionDestination, Record<string, unknown>>;

/** An empty bucket set — every destination present, so callers need no guards. */
function emptyBuckets(): RoutedExtraction {
  return { memory: {}, chat: {}, user: {}, stage: {} };
}

/**
 * Partition the model's extracted values by destination.
 *
 * `specs` is the merged agent → conversation → stage spec (stage wins), the
 * same list the tool schema was built from. A value the model returned that
 * no spec declares still gets filed, under the default destination: the model
 * is not a trusted source of field names, and silently dropping data an
 * author may be relying on is worse than filing it conservatively.
 */
export function routeExtractedData(
  data: Record<string, unknown>,
  specs: readonly ExtractionFieldSpec[],
): RoutedExtraction {
  const byName = new Map<string, ExtractionDestination>();
  for (const spec of specs) {
    const parsed = parseExtractionField(spec.field);
    byName.set(parsed.name, parsed.destination);
  }

  const buckets = emptyBuckets();
  for (const [name, value] of Object.entries(data)) {
    const destination = byName.get(name) ?? DEFAULT_EXTRACTION_DESTINATION;
    buckets[destination][name] = value;
  }
  return buckets;
}

/**
 * Merge a bucket into a node's `data` under `EXTRACTED_SUBKEY`, returning the
 * new `data`. Pure, so the caller decides how it is persisted (a chat root
 * goes through the #919 edit list; a stage node is written directly).
 */
export function mergeExtractedInto(
  existing: Record<string, unknown> | null | undefined,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const base = existing ?? {};
  const prior = (base[EXTRACTED_SUBKEY] as Record<string, unknown> | undefined) ?? {};
  return { ...base, [EXTRACTED_SUBKEY]: { ...prior, ...values } };
}

/**
 * Merge a bucket into the memory-level `data` node's per-user area for one
 * speaker.
 *
 * A null `userId` means the turn has no attributed speaker (an App-key
 * principal). Those values are DROPPED rather than filed under a placeholder:
 * a bucket keyed `unknown` would be read back as somebody's facts by the read
 * cascade, which is the whole failure this rule exists to prevent.
 */
export function mergeUserScopedInto(
  existing: Record<string, unknown> | null | undefined,
  userId: string | null,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const base = existing ?? {};
  if (!userId || Object.keys(values).length === 0) return { ...base };
  const users = (base[USERS_SUBKEY] as Record<string, unknown> | undefined) ?? {};
  const mine = (users[userId] as Record<string, unknown> | undefined) ?? {};
  return { ...base, [USERS_SUBKEY]: { ...users, [userId]: { ...mine, ...values } } };
}

/**
 * Build the Mustache/routing view for one turn, most-specific-last.
 *
 * memory-wide → stage → chat → the speaker's own values, each overriding the
 * one before. The per-user layer wins because the most specific thing the
 * platform knows about `{{industry}}` while a given person is talking is what
 * THAT person said.
 *
 * The memory layer's `users` bucket is dropped from the view rather than
 * exposed as a variable: it is the storage shape, not something a prompt
 * should address, and leaving it in would let a template read another
 * participant's values through `{{users.<id>.x}}` — reintroducing the bleed
 * by another route.
 */
export function buildExtractionView(layers: {
  memoryData?: Record<string, unknown> | null;
  stageData?: Record<string, unknown> | null;
  chatData?: Record<string, unknown> | null;
  userId?: string | null;
}): Record<string, unknown> {
  const view: Record<string, unknown> = {};

  const memoryData = layers.memoryData ?? {};
  for (const [key, value] of Object.entries(memoryData)) {
    if (key === USERS_SUBKEY) continue;
    view[key] = value;
  }

  const extractedOf = (data: Record<string, unknown> | null | undefined) =>
    (data?.[EXTRACTED_SUBKEY] as Record<string, unknown> | undefined) ?? {};

  Object.assign(view, extractedOf(layers.stageData));
  Object.assign(view, extractedOf(layers.chatData));

  if (layers.userId) {
    const users = (memoryData[USERS_SUBKEY] as Record<string, unknown> | undefined) ?? {};
    const mine = (users[layers.userId] as Record<string, unknown> | undefined) ?? {};
    Object.assign(view, mine);
  }

  return view;
}
