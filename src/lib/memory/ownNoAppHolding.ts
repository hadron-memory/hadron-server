/**
 * #5355 / #5026 (cor:api:120:03, cor:cht:010:02): the no-App holding `startChat` provisions when no licensed App qualifies is a
 * class-`knowledge`, org-owned memory carrying neither `userId` nor `ownerUserId`; its reader is its CREATOR. This is the ONE
 * predicate the GraphQL `memories()` list and MCP `hadron_list_memories` share (the node gates admit it as
 * `getAccessibleMemoryIds`'s `createdBy` holding clause and MCP's `readsOwnNoAppHolding`). Narrowed to `appId: null`: an
 * anonymous session memory stores an App id in `createdBy` and is class `app`. `createdBy` is compared with the user id only.
 */
export function ownNoAppHoldingWhere(userId: string) {
  return { class: 'knowledge' as const, appId: null, userMemoryOfAgentId: { not: null }, createdBy: userId };
}
