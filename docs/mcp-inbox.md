# Team-chat inbox and acknowledgement (retired on MCP)

**Retired on MCP (#3082).** The MCP inbox tools (`hadron_team_chat_inbox`, `hadron_team_chat_inbox_ack`) and the
rest of the agent-team MCP tools are disabled: the agent team works through the CLI and the portal, and MCP carries
agents, not workers. A call to one answers the MCP unknown-tool error. Use the CLI:

- read: `hadron team chat inbox`, display the returned text unchanged;
- acknowledge: the same command acknowledges only after complete output (see `hadron team chat inbox --help`).

Reading never acknowledges a delivery and changes neither its delivery mark nor the worker's read position.

The behaviour described below is unchanged: it lives in the shared delivery resolvers (GraphQL), which the CLI calls.
The authorization is the resolvers' own: self mode needs the worker's own live bound session in its own App; host mode
needs the host's App key with `attention:deliver` and `host:operate`, no session, and reaches only workers in that
host's current registration. Both the caller and the receiving worker must be allowed to read a channel; encrypted
channels are omitted, even when unlocked.

The proof of a delivery is returned **only in `batches[].id`** and is used only for acknowledgement. It is never placed
in displayed text, another output field, an error or a log. A proof is valid for 15 minutes; foreign, forged, expired
or stale coverage is refused without moving a mark, and an acknowledgement moves the delivery mark, never a read
position. If a read response is lost, the delivery stays due: read again. If an ack response is lost, retry the same
batch ids inside their validity window; repeated and concurrent acknowledgements are idempotent.

Governing contracts: `cor:agt:080:16`, `:17`, `:22`, `:23`, `:26`, including R53/R57 and the encrypted-chat exclusions.
The switch that disabled the tools is `src/mcp/disabledTools.ts`.
