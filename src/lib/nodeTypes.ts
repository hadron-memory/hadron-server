/**
 * #909 slice (a) — the one list of `Node.nodeType` values the platform names.
 *
 * `nodeType` stays a free string: nothing here validates a write, and a value outside these lists is
 * accepted exactly as before. These constants only give the schema comment and the MCP tool
 * descriptions one thing to cite, so the documented vocabulary cannot drift apart again.
 */

/** The canonical values for ordinary nodes, in alphabetical order. `info` is the default. */
export const ORDINARY_NODE_TYPES = [
  'abstract',
  'chat',
  'data',
  'info',
  'record',
  'reference',
  'system',
] as const;

/**
 * Kinds the platform itself writes or reserves, beyond the ordinary seven: values that carry platform-defined
 * meaning. NODE_TYPES (ordinary + these) is the full vocabulary the platform names.
 *
 * #5453 (Holger, 2026-11-27) took two values out. `compiled-boot-prompt` was never in the ruled vocabulary: a
 * compiled boot prompt is `system` and told apart by its role `prompt.boot.compiled`, and the database refuses the
 * old value. `task` left the vocabulary on 2026-05-11 (#118 D3) and nothing writes it.
 */
export const PLATFORM_DEFINED_NODE_TYPES = ['comment', 'chat-message'] as const;

/** Every node type the platform names. */
export const NODE_TYPES = [...ORDINARY_NODE_TYPES, ...PLATFORM_DEFINED_NODE_TYPES] as const;

export type NodeTypeName = (typeof NODE_TYPES)[number];

/** The default node type when a write names none. */
export const DEFAULT_NODE_TYPE: NodeTypeName = 'info';

/** The ordinary values as the MCP tool descriptions print them, with the default marked. */
export const ORDINARY_NODE_TYPES_TEXT = ORDINARY_NODE_TYPES.map((t) =>
  t === DEFAULT_NODE_TYPE ? `${t} (default)` : t,
).join(', ');

/** The platform-written kinds, as printed in the MCP tool descriptions. */
export const PLATFORM_DEFINED_NODE_TYPES_TEXT = PLATFORM_DEFINED_NODE_TYPES.join(', ');
