# The generic internal-error envelope (#1789)

Server half of #1789 (cor:api:260:01). The umbrella stays open: the CLI (hadron-cli#898) and portal (hadron-memory/hadron-portal#1132) bind to this after it lands.

## Contract

An error that is not a typed domain refusal shows the caller one code, a fixed message and a request id:

| Surface | Carrier |
|---|---|
| GraphQL | `errors[].extensions = { code: "INTERNAL_SERVER_ERROR", requestId }`, `message: "Internal server error."` |
| MCP | `isError: true`, `structuredContent.error = { code, requestId, message }`, text fallback `[INTERNAL_SERVER_ERROR] Internal server error. Request id: <id>` |
| Plain HTTP | 500 `{ error: "Internal server error.", code, requestId }` (OAuth endpoints keep their RFC 6749/7591 body and add `request_id`) |
| All HTTP | `X-Request-Id` response header, the same value; CORS-exposed |

The request id is a server-generated UUIDv4, one per HTTP request, shared by every fault and log record of that request, distinct across requests. An incoming `X-Request-Id` is ignored. `/capabilities` is mounted before the id is assigned: its answer is byte-identical and ETag-cached. The complete exception is logged as `[<surface>] internal_fault { requestId, site, error }`.

## What counts as a typed refusal (`isTrustedRefusal`, `api/graphql/formatError.ts`)

- a class in `CLIENT_ERROR_MAPPINGS`, or
- a `GraphQLError` this server raised with an explicit code other than `INTERNAL_SERVER_ERROR`.

A plain `Error` is a fault whatever its text; there is no prose allowlist. Refusals that were plain `Error` are typed instead (see below). Framework refusals (GraphQL parse/validation, HTTP 401, body-parser 4xx) keep today's behaviour, per the gate's carve-out.

## Refusals typed in this change (the inventory of plain `Error` refusals that would otherwise have gone generic)

- `new Error('Forbidden' | 'Unauthenticated')`, 84 sites in 22 files, now `forbiddenError()` / `unauthenticatedError()` (`lib/refusals.ts`). Same message; the wire code becomes `FORBIDDEN` / `UNAUTHENTICATED` instead of `INTERNAL_SERVER_ERROR`.
- Attaching a system memory as a memory item: `BAD_USER_INPUT`.
- `syncMemory` failure: `SYNC_FAILED`; the text is the stored `Memory.syncError`, already readable by the caller.
- `GitCommandError`: mapped, `GIT_COMMAND_FAILED`, fixed message by design (#1578).

Every other `throw new Error(...)` (about 450) is now a fault on the wire. The test suite is the discovery mechanism: the refusals it showed as user-facing are the four above. A refusal not covered by a test would surface as the generic envelope; the log line carries its text.

## MCP

Every tool catch goes through `toolErrorResult` (typed: text kept, `isError` set; otherwise the fault envelope). The registration wrapper (`withToolErrorBoundary`) genericizes any throw that is not typed, instead of letting the SDK echo the message. Refusals that were returned as success-shaped text now set `isError: true`.

## Residual

- Memory sync stores `error.message` in `syncError` for any exception; that pre-existing store is not changed here.
- MCP success-shaped refusals were converted by reading each return; a refusal returned through a helper this pass did not find would still lack `isError`.
- Framework refusals stay as they are until ruled on.
