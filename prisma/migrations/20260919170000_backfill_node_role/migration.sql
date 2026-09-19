-- #1216 — backfill `nodes.role` across the existing spec and review corpora.
--
-- #1201/#1203 govern a node by what a WRITE produces. Everything authored
-- before they shipped carries no `role`, so the feature protects only what has
-- been written since — 421 of the platform's oldest and most load-bearing nodes
-- were outside it. This closes that, once.
--
-- A MIGRATION rather than a CLI sweep (@Holger). Not because the CLI cannot do
-- it — `hadron node update --role spec` succeeds, since `UpdateNodeByKind`
-- routes to the door that exempts itself — but because `NodeRevision` is a
-- CURATED subset by design and N calls would mint N revisions for a mechanical
-- stamp, and because this must not half-apply across 421 rows.
--
-- ONE `DO` BLOCK, WHICH IS ONE STATEMENT, WHICH IS ATOMIC (@codex P1 on PR
-- #1222). The first version was three top-level statements relying on Prisma
-- wrapping the file in a transaction — and "cannot half-apply" was written in
-- this header as the REASON for choosing a migration while nothing in the file
-- guaranteed it. A raise from the assertion could have left the UPDATEs
-- committed and the deployment needing P3009 recovery with the stamps half
-- applied. A `DO` block rolls back as a unit no matter how the migration runner
-- treats the file, so the stated reason is now true rather than assumed.
--
-- The assertion also runs FIRST rather than last — though measured honestly,
-- that is belt-and-braces rather than the guarantee: mutating it back to the
-- end reds nothing, because the `DO` block already rolls the UPDATEs back when
-- it raises. The block is what makes a refusal inert; running the check first
-- only makes it obvious. Said plainly so the next reader does not credit the
-- ordering with work the atomicity is doing.
--
-- IT BYPASSES THE RESOLVER GATE BY CONSTRUCTION, and that is correct for a
-- trusted one-shot rather than an oversight: `assertGovernedWrite` refuses a
-- generic writer that would PRODUCE a governed node, and this is exactly such a
-- write. Stated so a reader does not go looking for the refusal that did not
-- fire.
--
-- IDEMPOTENT: both UPDATEs are guarded on `role IS NULL OR role = ''`, so a
-- re-run stamps nothing. It is a no-op, not a second stamp — and idempotency is
-- also the recovery path if a deploy ever fails between statements.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECTION — measured on production before writing, not reasoned from the
-- issue. The control the issue asked for is what changed the predicate.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The issue proposed selecting reviews by TAG (`review-criteria`) with the loc
-- prefix as a CONTROL, on the principle that governance is a property of the
-- node rather than of its address. Running both and diffing — which the issue
-- required, and which is the only reason this is known:
--
--   memory            by tag  by loc  tag-only  loc-only
--   hadron-cli            35      35         0         0
--   hadron-portal         59      60         0         1
--   hadron-server         13      33         0        20
--   dev                    0       0         0         0
--
-- The tag set is a strict SUBSET: it misses 21 genuine checks, one of them with
-- EMPTY tags (hadron-cli#1152 — `node update` drops tags — exactly the node the
-- sweep exists for). Widening to the bare `review` tag over-corrects in the
-- other direction: `dev` has three nodes tagged `review` that are a
-- `conventions:` node and two `findings:` nodes ABOUT review, not review
-- criteria. Topic tags and kind markers are not the same thing.
--
-- So the address is the reliable discriminator for this ONE historical
-- population. That is not re-importing the axis #1201 removed: the GATE still
-- keys on `role`, and identifying which existing rows should carry it is
-- archaeology, not policy.
--
-- `dev` is in the issue's scope table and contributes ZERO. Verified rather
-- than assumed — a zero is an instrument fault until a control says otherwise:
-- it holds 190 live nodes and no `review:` subtree at all.
--
-- NOT RUNNABLE, on both halves. A node carrying `role = 'review'` AND
-- `isRunnable` matches two governed kinds at once, and the doors then refuse it
-- from both directions — `createTaskNode` for the role, `createSpecNode` for
-- the capability — leaving it editable through nothing (hadron-cli#615). No row
-- in either set is runnable today, so this guard changes no row; it is here so
-- that a re-run after someone marks one runnable still cannot produce that
-- state. The specs memory makes the hazard concrete: it holds
-- `tasks:create-platform-spec`, a runnable task.
--
-- SCOPE: `hadronmemory.com` only. Explicitly NOT `micromentor.org` — a
-- different org and a different customer; applying this register retroactively
-- to their corpus is not a decision this team takes unilaterally.
--
-- Keyed on memory URN rather than id: ids differ per environment, and this file
-- runs against dev, test and production. Where the memories do not exist the
-- UPDATEs match nothing, which is the correct no-op.
DO $$
DECLARE
  conflicted integer;
  spec_rows  integer;
  rev_rows   integer;
  review_memories constant text[] := ARRAY[
    'hadronmemory.com:hadron-server',
    'hadronmemory.com:hadron-cli',
    'hadronmemory.com:hadron-portal',
    'hadronmemory.com:dev'
  ];
BEGIN
  -- ── pre-condition ────────────────────────────────────────────────────────
  -- A governed node that is ALSO runnable is the state the guards below exist
  -- to prevent; the guards cannot produce it, but something upstream could, and
  -- shipping a node no door can edit is worse than refusing to run.
  --
  -- SCOPED to the memories this migration touches (@copilot, PR #1222). A
  -- platform-wide scan made an out-of-scope customer's data an availability
  -- dependency of our deployment: one pre-existing bad row in `micromentor.org`
  -- — a corpus this migration deliberately will not touch — would have aborted
  -- the whole deploy. A check must not reach further than the change it guards.
  SELECT count(*) INTO conflicted
  FROM nodes n
  JOIN memories m ON m.id = n.memory_id
  WHERE n.deleted_at IS NULL
    AND m.urn = ANY(ARRAY['hadronmemory.com:specs'] || review_memories)
    AND n.role IN ('spec', 'review')
    AND n.is_runnable IS TRUE;

  IF conflicted > 0 THEN
    RAISE EXCEPTION
      'backfill_node_role: % in-scope node(s) carry a governed role AND isRunnable, which no door can edit (#1216)',
      conflicted;
  END IF;

  -- ── specs: the citation-shaped corpus ──────────────────────────────────
  -- FULLY ANCHORED (@codex P2, @copilot, PR #1222). The first version anchored
  -- only the start, so `cor:acl:010draft` and `cor:acl:010:01:notes` were
  -- "citation-shaped" and would have been governed — arbitrary nodes made
  -- uneditable by a prefix match, with the migration's real scope depending on
  -- what the corpus happened to contain on the day I measured it.
  --
  -- The accepted shape is a complete citation at feature, rule or flow depth:
  --   cor:<module>:<feature>[:<rule>[:<flow>]]
  -- Measured against production, the anchored form selects the SAME 294 rows —
  -- 81 at depth 3, 212 at depth 4, 1 at depth 5 (`cor:aut:030:01:01`, which is
  -- why the flow level is in the pattern rather than assumed absent).
  --
  -- It deliberately excludes the 18 MODULE roots (`cor`, `cor:acl`, …),
  -- `platform-specs`, `register`, a test node, and the runnable task — 22 of
  -- the memory's 316. The module roots are a genuine judgement call rather than
  -- an obvious exclusion: they are corpus index nodes and `hadron spec ls`
  -- lists them, so an argument exists for governing them too. Left OUT because
  -- the issue says "citation-shaped loc" and under-governing is the recoverable
  -- direction — a later migration can add them; one that wrongly governs a node
  -- needs someone with a door to undo it.
  UPDATE nodes n
     SET role = 'spec', updated_at = now()
    FROM memories m
   WHERE m.id = n.memory_id
     AND m.urn = 'hadronmemory.com:specs'
     AND n.deleted_at IS NULL
     AND n.loc ~ '^cor:[a-z]+:[0-9]+(:[0-9]+){0,2}$'
     AND n.is_runnable IS NOT TRUE
     AND (n.role IS NULL OR n.role = '');
  GET DIAGNOSTICS spec_rows = ROW_COUNT;

  -- ── reviews: the four repo memories ────────────────────────────────────
  -- `role = ''` sits beside `IS NULL` deliberately (#1219): the server stores an
  -- empty-string role verbatim while the adjacent `objectType` normalizes it to
  -- null, so `role IS NULL` alone would skip a node that is ungoverned to every
  -- reader. No live row carries `''` today — the guard is written against the
  -- COLUMN's semantics rather than against today's data, because a predicate
  -- that is only correct because of the current rows is the same class of
  -- mistake as selecting a relationship by category.
  UPDATE nodes n
     SET role = 'review', updated_at = now()
    FROM memories m
   WHERE m.id = n.memory_id
     AND m.urn = ANY(review_memories)
     AND n.deleted_at IS NULL
     AND n.loc LIKE 'review:%'
     AND n.is_runnable IS NOT TRUE
     AND (n.role IS NULL OR n.role = '');
  GET DIAGNOSTICS rev_rows = ROW_COUNT;

  -- Deploy-log observability: a data migration that reports nothing leaves the
  -- operator comparing counts by hand. Expected on the first production run:
  -- 294 spec, 127 review. A re-run must print 0 and 0.
  RAISE NOTICE 'backfill_node_role: stamped % spec node(s), % review node(s)', spec_rows, rev_rows;
END $$;
