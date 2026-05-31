# Quickstart: Node `abstractOriginHash` — stale-abstract detection

Manual smoke recipe for verifying staleness end-to-end against a local dev server. Aimed at the implementing engineer or a reviewer doing a hands-on verification pass before merge.

## Prerequisites

- Local Postgres with `hadron_dev` (per CLAUDE.md).
- `prisma db push` has applied the schema delta (including the new `abstract_origin_hash` columns on both `nodes` and `node_versions`).
- `prisma/post-push.sql` re-applied.
- Dev server running locally: `pnpm tsx src/index.ts` (default port 4000).
- A valid App Key (`hdr_app_…`) — get one from `prisma/seed.ts` output.

## Smoke recipe

### Step 1 — Author a node with abstract + content (fresh state)

```
h-add-node
  urn: hadronmemory.com::dev::test:staleness
  name: Staleness smoke test
  abstract: This is a paragraph summary of the original content.
  content: |
    # Original content
    This is the body that the abstract above is supposed to summarise.
```

**Expected**: success. Inspect the DB row to confirm both hashes match:

```
psql -d hadron_dev -c "select abstract_origin_hash, content_hash from nodes where loc = 'test:staleness';"
```

Both columns should be 8-char hex strings AND equal to each other. Fresh state.

### Step 2 — Read with `contentScope: 'all'`: no staleness marker

```
h-read-node
  urn: hadronmemory.com::dev::test:staleness
  contentScope: all
```

**Expected**: response is `meta block + abstract + --- + body`. NO `Source: abstract-stale` line in the meta block. Pre-flight: fresh state.

### Step 3 — Update only the content (arm the staleness signal)

```
h-update-node
  urn: hadronmemory.com::dev::test:staleness
  content: |
    # Updated content
    This body has changed. The abstract above no longer accurately summarises it.
```

(No `abstract` field in the request — preserve the existing abstract.)

**Expected**: success. Inspect the DB row again:

```
psql -d hadron_dev -c "select abstract_origin_hash, content_hash from nodes where loc = 'test:staleness';"
```

The two hashes should now **differ**. `abstract_origin_hash` is unchanged from Step 1 (the original content's hash). `content_hash` is the new content's hash. The staleness signal is armed.

### Step 4 — Read with `contentScope: 'all'`: marker now appears

```
h-read-node
  urn: hadronmemory.com::dev::test:staleness
  contentScope: all
```

**Expected**: response contains `Source: abstract-stale` in the meta block (positioned just after `Type:`, before `Tags:`). Body renders normally — the marker is the only behavioural change.

### Step 5 — Default scope: no marker (sanity)

```
h-read-node
  urn: hadronmemory.com::dev::test:staleness
```

**Expected**: response is byte-identical to a fresh-node default-scope read. NO `Source: abstract-stale` line — the abstract isn't in the response, so the marker would alarm without reason (FR-010).

### Step 6 — Run `h-validate`: stale-abstract warning appears

```
h-validate
  memoryUrn: hadronmemory.com::dev
```

**Expected**: report includes `[stale-abstract] urn:node:hadronmemory.com::dev::test:staleness — abstract may not reflect current content`. Other nodes in the dev memory should NOT be flagged (they have `abstract_origin_hash IS NULL` from before this spec shipped, and the check short-circuits).

### Step 7 — Refresh the abstract: marker clears

```
h-update-node
  urn: hadronmemory.com::dev::test:staleness
  abstract: |
    Updated paragraph summary that now reflects the new body content.
```

**Expected**: success. Inspect the DB row:

```
psql -d hadron_dev -c "select abstract_origin_hash, content_hash from nodes where loc = 'test:staleness';"
```

Both hashes should be equal again — the refresh affirms "this abstract matches current content."

### Step 8 — Read with `contentScope: 'all'`: marker gone

```
h-read-node
  urn: hadronmemory.com::dev::test:staleness
  contentScope: all
```

**Expected**: no `Source: abstract-stale` line. Back to fresh state.

### Step 9 — `h-validate`: clean

```
h-validate
  memoryUrn: hadronmemory.com::dev
```

**Expected**: no `[stale-abstract]` warnings for this node.

### Step 10 — Legacy node sanity check

Find a node created BEFORE this spec shipped (any node with `abstract IS NOT NULL` from spec 031's era — likely none in dev, but if any exist):

```
psql -d hadron_dev -c "select loc from nodes where abstract is not null and abstract_origin_hash is null limit 1;"
```

If a row exists, read it with `contentScope: 'all'`: NO marker. The legacy null-hash short-circuits the staleness check — no false positive on pre-spec content (FR-007 + SC-004).

### Step 11 — Restore version round-trip

Set a version-history checkpoint then restore it:

```
h-update-node
  urn: hadronmemory.com::dev::test:staleness
  reason: snapshot before restore-test
```

(Captures a NodeVersion row with current state.)

Then make a change and restore:

```
h-update-node
  urn: hadronmemory.com::dev::test:staleness
  abstract: Different abstract.
```

Find the version ID:

```
psql -d hadron_dev -c "select id from node_versions where node_id = (select id from nodes where loc = 'test:staleness') order by created_at desc limit 1 offset 1;"
```

Then call `restoreNodeVersion` via GraphQL (or whatever the portal surface uses).

**Expected**: the restored node has `abstract_origin_hash` equal to the version's snapshot value. If the version was captured pre-spec, the hash is NULL; the staleness check short-circuits; no false signal (FR-002 + research D4).

### Step 12 — Cleanup

```
h-delete-node
  urn: hadronmemory.com::dev::test:staleness
  hard: true
```

## Expected outcomes summary

| Step | Check | Expected |
|---|---|---|
| 1 | DB row after fresh write | both hashes populated, equal |
| 2 | h-read-node 'all' fresh | no `Source: abstract-stale` |
| 3 | DB row after content-only update | hashes differ; signal armed |
| 4 | h-read-node 'all' stale | `Source: abstract-stale` present |
| 5 | h-read-node default stale | no marker (abstract not in response) |
| 6 | h-validate stale | `[stale-abstract]` warning for this node only |
| 7 | DB row after abstract refresh | hashes equal again |
| 8 | h-read-node 'all' refreshed | no marker |
| 9 | h-validate refreshed | clean |
| 10 | Legacy node | no marker (short-circuit) |
| 11 | restoreNodeVersion | hash restored verbatim; no recomputation |
| 12 | Cleanup | node deleted |
