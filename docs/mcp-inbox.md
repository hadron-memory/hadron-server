# MCP inbox and acknowledgement

The C7 tools expose the shared S1 delivery service. Read with
`hadron_team_chat_inbox`, display the returned `text`, then acknowledge with
`hadron_team_chat_inbox_ack`. Reading never acknowledges a delivery and changes
neither its delivery mark nor the worker's read position. Authorized reads may
record audit facts.

## Callers

A worker supplies its own live bound `session` in its own App. It can read and
acknowledge only its own deliveries. An ended, revoked or foreign binding is
refused. Self mode also admits an active App key on a same-App **userless**,
non-host-launched own-worker session, if that key has never held `host:operate`.
It still supplies `session`, passes the existing session-write gate and reads
only the memories that key-bound session may read. It cannot borrow a person's
session or gain channel access merely by naming a worker; an eligible self call
can therefore return no batches. This is separate from host mode.

A host uses its actual App key with both `attention:deliver` and
`host:operate`, without a session binding, and reaches only workers in that
host's current registration. A holder or manager token alone does not substitute
for either batch caller.

Both the caller and receiving worker must be allowed to read a channel. Encrypted
channels are omitted, even when unlocked. The tools do not add a rendering,
eligibility or acknowledgement policy of their own.

## Read

Self mode:

```json
{"appRef":"<App id or URN>","session":"<own live worker session>"}
```

A host omits `session`. Optional `workerRefs` narrows its registered workers;
self mode accepts only the bound worker. `first` pages workers (default 50,
maximum 200); pass the returned `pageInfo.endCursor` as `after` when there is
another page.

The MCP text content is a JSON object with `batches` and `pageInfo`. Each batch
contains:

| Field | Meaning |
| --- | --- |
| `id` | Opaque signed batch proof, used only for acknowledgement |
| `worker`, `workerId` | Receiving worker name and id |
| `text` | Shared server-rendered delivery text; display it unchanged |
| `deliverAfter`, `busyDeadline` | Server-owned timing values |
| `interrupt` | Shared delivery interruption instruction |
| `overflow` | Eligible messages beyond the rendered sample |
| `ranges` | Rendered coverage: channelId, incarnation, fromSeq, throughSeq, seqs |

The proof is returned **only in `batches[].id`**. Do not reconstruct it or place it
in displayed delivery text, another output field, an error or a log. Bearer
credentials, App/host keys and session credentials are never response content.
The CLI C7 consumer and MCP consume the same service's text, ranges and batch
identity; clients must not apply a second formatter.

## Acknowledge

After the delivery reaches the worker, call the separate ack tool:

```json
{"batchIds":["<id from batches[].id>"],"session":"<same own live worker session>"}
```

A host again uses its receiving key and omits `session`. The receiving caller
must still be authorized, and the proof must be within 15 minutes of issuance.
Foreign, forged, expired or stale coverage is refused without moving a mark.
An acknowledgement moves the delivery mark through the rendered ranges; it
never moves a read position.

For one batch, optional `through` narrows the acknowledged channels to rendered
sequence numbers:

```json
{"batchIds":["<batch id>"],"through":[{"channelId":"<rendered channel id>","seq":42}],"session":"<same own live worker session>"}
```

The response is text such as `Acknowledged 1.` or
`Acknowledged 0 (1 already delivered).` Never include the proof in status/error
output or logs.

## Lost responses and repeats

- If the read response is lost or the client disconnects before acknowledgement,
  the delivery stays due. Read again; do not acknowledge unseen text.
- If the ack response is lost, retry the same `batchIds` within their validity
  window. Repeated and concurrent acknowledgements are idempotent.
- If the proof expired, read a current batch. Keep the shared authorization and
  coverage checks; do not manufacture a replacement proof.

A textless wake acknowledgement (`hadron_ack_wakes`) records its wake receipt,
ticks/tasks and applicable budget; under R53 it cannot mark message text as
delivered. It does not replace a text-batch acknowledgement.

## Contract and integration

The registered descriptions and input schemas in `src/mcp/tickerTools.ts` are the
MCP discovery manifest. The handlers delegate to the shared delivery resolvers;
this reference introduces no additional engine or authority. Governing contracts:
`cor:agt:080:16`, `:17`, `:22`, `:23`, `:26`, including R53/R57 and encrypted-chat
exclusions. Credential/proof acceptance and the two tool names are pinned by
server issue #2057; CLI parity is tracked in hadron-cli#912.

This reference accompanies the S1 integration branch. Integrated review/QA,
S1/S2 reconciliation, safe shared error formatting (#2087 / PR #2090), and
coordinated client cutover remain required before activation. It is not an
activation or production-readiness receipt.
