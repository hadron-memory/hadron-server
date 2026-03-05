## Hadron Controller

The Hadron Controller is the central server for the Hadron graph system. It maintains a synchronized copy of all organization graphs, exposes a GraphQL API for querying and mutating graph data, and records usage telemetry from AI agents and developer tools.

### Responsibilities

| Responsibility | Description |
|---|---|
| Graph hosting | Stores all Hadron nodes and edges in a database, queryable via GraphQL |
| Graph sync | Clones/pulls graph repos from GitHub, parses nodes from filesystem, upserts into DB |
| Usage telemetry | Records `UsageEvent` records from client tools (which nodes were accessed, which actions ran) |
| Session tracking | Tracks AI agent and chatbot sessions with token counts and outcomes |
| Authentication | GitHub OAuth for humans, API keys for machine clients |
| Admin API | Manages clients (API keys), users, and roles |

### Technology Stack

- **Runtime**: Node.js (ESM), TypeScript
- **HTTP**: Express 4
- **GraphQL**: Apollo Server 4 + `expressMiddleware`
- **Database ORM**: Prisma 6
- **Auth**: `jose` (JWT), `bcrypt` (API key hashing)
- **Config parsing**: `yaml`

### Entry Points

- `src/index.ts` — bootstraps the server, triggers graph sync on startup
- `src/server.ts` — creates the Express app, registers all routes
- `src/controller/controller.ts` — barrel for all controller operations
