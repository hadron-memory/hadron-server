# Team-chat sequence uniqueness (#992 Slice 1)

**Landing/deployment hold:** the authorized operator must run a fresh read-only
preflight against the target database and record zero collisions, plus the approved
message/citation disposition, before this migration lands/applies. Holger reported
hard-deleting the postmigration duplicate seq 3, preserving
`chats:team:messages:003-academy-iris`. That report is not independent verification
and does not authorize another repair. This PR uses `Refs #992`; Slice 2 remains.

Run with DATABASE_URL supplied privately in the operator's environment:

```sh
pnpm tsx scripts/team-chat-seq-preflight.ts
```

The command opens a repeatable-read **read-only** transaction. It reports the
canonical message/root counts (decimal strings), tombstones, and every collision's
root, memory, seq and message IDs/addresses/deletion times. No message bodies,
envelopes or credentials are read. Exit 0 means zero collisions in that snapshot;
5 means collisions; 1 means no successful census; 2 means missing connection
configuration. A failure is never interpreted as an empty eligible set. Save the
report with the target deployment/version and operator verification time. Do not
print the connection string.

No command here repairs anything. Unresolved collisions require a separately
authorized row/citation disposition. Never renumber, delete, exempt a row or
reinterpret a citation automatically. The migration repeats the same collision
check under write-blocking table locks and refuses with TEAM_CHAT_SEQ_COLLISIONS
before committing any installation change. Thus a new collision after the operator
snapshot also refuses. Standard migration failure recovery is operator-owned;
this preflight hold exists to avoid entering that failure in production.

## Canonical identity inventory

The classifier is `prisma/team-chat-seq-candidates.sql`, embedded byte-for-byte in
the invariant/migration and used directly by the read-only command. It follows
`locateTeamChatRoot`, `teamSpaceAudienceFilter` and `teamSpaceOwnerFilter`:

- Same memory as a `chat` root at exact `chats:team`.
- Host class `app` with an existing App, no Worker claiming the memory, no
  session-memory agent discriminator, and owner either null or the App owner.
- `chat-message`, nonnull seq, under that root's **literal** `:messages:` prefix.
- Root, memory, App and message tombstones retain identity: deletion never frees a
  seq. No envelope test, including for encrypted messages.

This deliberately covers all eligible roots rather than only the oldest live root
selected by the App convenience read: a historical root must not lose protection
when another live root becomes the selected one. Key identity is the root Node ID,
not the root's name, messageChannelId, creator, envelope or an App default pointer.
Equal seq in different roots remains legal. Ordinary chatbot `record`, counterless,
summary/foreign kinds and named Channels outside this identity are excluded.

`postToRoot` and system notices insert through `appendChatMessage` in the same
transaction as counter, Channel watermark, mention envelope and reply edge.
GraphQL/MCP posts share that path. The allocator's existing max(counter, max real
message seq) and `record`/`chat-message` allowlist are unchanged. Summaries still
never shift messageCount or routing. Generic node create/update/import/clone,
subtree moves and Git sync retain their existing protected-Channel refusal;
pre-Channel clone/import remains an eligible historical writer.

`messageChannelId` is only a scan projection: migration/adoption stamped live
messages under live Channels. Tombstones and pre-Channel imports may be null.
A projection-only unique would miss them. See Hadron finding
`findings:team-chat-seq-key-needs-canonical-classifier`.

## Enforcement and refusal

Private `TeamChatSequenceKey` rows map eligible Node IDs to `(root ID, seq)` with
a database unique key. Node insert/update/delete triggers maintain them. Root,
Memory, Worker-memory and App-owner classification transitions rebuild only the
affected memory, so moving/importing/adopting a collision refuses atomically.
Soft delete/revive leaves the key intact. Hard deletion removes its key with the
node; this does not create a production repair surface.

A private per-memory MVCC fence tuple serializes membership decisions, including
raw storage writers. Unlike an advisory lock alone, its version update aborts a
stale repeatable-read/serializable snapshot after a concurrent classification
change. Ordinary unrelated Node paths do not take this fence. Team message
inserts update one key; only classification/root changes rebuild a memory's keys.

All Prisma operations share the fixed SQLSTATE translation:
`TEAM_CHAT_SEQ_CONFLICT`, with a fixed explanation and no raw database diagnostics,
conflicting row, cause or SQL. Callers include canonical insert callbacks,
pre-Channel GraphQL/MCP clone/import/update, and moves/adoption if they would
introduce an occupied key. Public post callers still cannot select a seq. No new
public field or client option is introduced.

The former attention duplicate-seq scan fixture now uses an ordinary named
Channel; its assertions remain. That preserves legal legacy tie scanning without
manufacturing a new forbidden canonical team-chat collision. Gaps/contiguity at
import remain a Slice 2/Holger follow-up question, not a change here.
