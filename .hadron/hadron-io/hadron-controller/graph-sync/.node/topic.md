## Graph Sync

Graphs are defined in `.hadron-controller.yaml` at the project root. Each entry maps a graph name to a GitHub repo and a local path under `SOURCES_PATH`.

### Configuration

```yaml
# .hadron-controller.yaml
graphs:
  micromentor-org/mmdata:
    source: "git@github.com:micromentor-team/mmdata.git"
    version: "latest"
    path: "micromentor-team/mmdata"
    updatedAt: "2026-02-19T00:00:00.000Z"
```

- **Graph name** (the key) is also the namespace: slashes become dots
  (`micromentor-org/mmdata` → namespace `micromentor-org.mmdata`)
- **path** is relative to `SOURCES_PATH` (default `./sources`, Docker: `/var/lib/hadron/sources`)

### Sync Flow

```
syncGraphFromGithub("micromentor-org/mmdata")
  ↓
1. Look up config for this graph name
2. git pull  (if SOURCES_PATH/micromentor-team/mmdata/.git exists)
   git clone (otherwise)
  ↓
3. loadGraphFromFs(graphPath, graphName, ownerRepo)
   → walk directory tree looking for .node/ dirs
   → for each dir: loadNodeFromFs(dir, graphRoot, ownerRepo)
      → read .node/node.yaml  (name, description, tags, edges)
      → read .node/topic.md   (content)
      → derive loc from path  (dir/path → dot-separated loc)
  ↓
4. DB transaction:
   a. deleteMany nodes where namespace = "micromentor-org.mmdata"
      AND ownerRepo = "micromentor-team/mmdata"
   b. create each node
   c. for each edge in node.yaml's "nodes:" array:
      upsert Edge (sourceLoc → targetLoc, label = rel)
```

### Node Filesystem Format

Every node in a graph repo lives in a directory. The directory path maps to the node's `loc`:

```
SOURCES_PATH/micromentor-team/mmdata/
└── micromentor-org/                     ← loc: micromentor-org
    └── mmdata/                          ← loc: micromentor-org.mmdata
        └── services/                    ← loc: micromentor-org.mmdata.services
            └── channels/                ← loc: micromentor-org.mmdata.services.channels
                └── .node/
                    ├── node.yaml        ← metadata + outgoing edges
                    └── topic.md         ← markdown content
```

`node.yaml` format:
```yaml
name: channels
description: The channels service handles real-time messaging
tags:
  - service
  - channels
nodes:
  - loc: micromentor-org.mmdata        # outgoing edge target
    rel: Parent concept — the mmdata backend
  - loc: micromentor-org.mmdata.services.channels.mm2-channel-lock
    rel: A specific behavior of the channels service
```

### Trigger Points

| Trigger | Action |
|---|---|
| Server boot | `controller.startup()` — syncs all configured graphs |
| `POST /reload` | Re-runs `controller.startup()` (e.g., called by CI after a push) |
| Manual | Call `controller.syncGraphFromGithub(name)` directly |

### Key Files

| File | Role |
|---|---|
| `src/config.ts` | `loadConfig()`, `SOURCES_PATH`, `graphNameToNamespace()` |
| `src/controller/startup.ts` | Iterates graphs and calls sync |
| `src/integrations/github/syncGraphFromGithub.ts` | git + load + DB upsert |
| `src/integrations/localFs/loadGraphFromFs.ts` | Directory walk → nodes + edges |
| `src/integrations/localFs/loadNodeFromFs.ts` | Parse single `.node/` directory |
| `src/integrations/localFs/saveNodeToFs.ts` | Write a node back to filesystem |
