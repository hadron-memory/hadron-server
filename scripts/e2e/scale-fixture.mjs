#!/usr/bin/env node
/** #2899: emit a small bulk-SQL program for the disposable E2E database only.
 * Pipe into the named stack's psql; never reads a URL or production data.
 * Postgres generates rows in-place: no million-row file or host JS array.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function fixtureSql(count, seed = 'perf-2899') {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error('count must be 1..1000000');
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(seed)) throw new Error('seed must be 3..32 lowercase letters/digits/hyphens');
  const id = (s) => createHash('sha256').update(`hadron-scale:${seed}:${s}`).digest('hex').slice(0, 32);
  const org = createHash('sha256').update('hadron-e2e:e2e-alpha').digest('hex').slice(0, 32);
  const memory = id(`memory:${count}`), control = id('control');
  // All interpolated strings are either restricted seed or hex; count is bounded integer.
  return `\\set ON_ERROR_STOP on
\\timing on
BEGIN;
SET LOCAL statement_timeout = '20min';
SET LOCAL lock_timeout = '10s';
DO $guard$ BEGIN
 IF current_database() <> 'e2e' OR current_user <> 'e2e' THEN
  RAISE EXCEPTION 'scale fixture refuses anything except disposable e2e database and role';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM organizations WHERE id='${org}' AND urn='e2e-alpha')
 OR NOT EXISTS (SELECT 1 FROM users WHERE email='alpha-admin@e2e.test') THEN
  RAISE EXCEPTION 'standard synthetic E2E seed required';
 END IF;
 IF EXISTS (SELECT 1 FROM memories WHERE id='${memory}' OR urn='e2e-alpha:${seed}-${count}') THEN
  RAISE EXCEPTION 'scale memory already exists; use a fresh stack or another seed';
 END IF;
 IF EXISTS (SELECT 1 FROM memories WHERE (id='${control}' OR urn='e2e-alpha:${seed}-control')
   AND (id='${control}' AND urn='e2e-alpha:${seed}-control' AND organization_id='${org}'
     AND data->>'fixture'='2899' AND data->>'seed'='${seed}') IS NOT TRUE) THEN
  RAISE EXCEPTION 'control identity collision';
 END IF;
END $guard$;
INSERT INTO memories (id,organization_id,urn,name,class,visibility,tags,data,updated_at,vector_index_enabled)
VALUES ('${memory}','${org}','e2e-alpha:${seed}-${count}','Synthetic scale ${count}','knowledge','ORGANIZATION',ARRAY['e2e','scale-2899'],
 jsonb_build_object('fixture','2899','seed','${seed}','count',${count}), '2026-01-01',false);
INSERT INTO memories (id,organization_id,urn,name,class,visibility,tags,data,updated_at,vector_index_enabled)
VALUES ('${control}','${org}','e2e-alpha:${seed}-control','Synthetic one-node control','knowledge','ORGANIZATION',ARRAY['e2e','scale-2899'],
 jsonb_build_object('fixture','2899','seed','${seed}','count',1),'2026-01-01',false) ON CONFLICT (id) DO NOTHING;
-- First 1000 nodes are folders; subsequent nodes fill wide groups of 5000 children.
-- The last ten entries form a depth-10 path, independent of the wide folders.
CREATE TEMP TABLE scale_rows ON COMMIT DROP AS
SELECT '${memory}'::text memory_id,i,
 CASE WHEN ${count}>=20 AND i>=${count}-10 THEN 'deep:' || array_to_string(ARRAY(SELECT 'd'||j FROM generate_series(1,i-(${count}-10)+1) j),':')
 WHEN i<1000 THEN 'g'||lpad(i::text,4,'0')
 ELSE 'g'||lpad(((i-1000)/5000)::text,4,'0')||':n'||lpad(i::text,7,'0') END loc
FROM generate_series(0,${count}-1) i;
INSERT INTO scale_rows SELECT '${control}',0,'welcome' WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE memory_id='${control}');
INSERT INTO nodes (id,memory_id,loc,name,abstract,abstract_origin_hash,content,tags,seq,updated_at,created_at,
 rev_seq,approved_rev_no,approved_by_info,approved_at,approval_hash)
SELECT md5('${seed}:'||memory_id||':'||loc),memory_id,loc,title,summary,substr(encode(sha256(convert_to(body,'UTF8')),'hex'),1,8),body,ARRAY['synthetic','scale-2899'],i,'2026-01-01','2026-01-01',
 2,2,'fixture:2899','2026-01-01',encode(sha256(convert_to(
 'hadron-approval-v1' || chr(10) || 'title '||octet_length(title)||chr(10)||title||chr(10)||
 'abstract '||octet_length(summary)||chr(10)||summary||chr(10)||
 'content '||octet_length(body)||chr(10)||body||chr(10),'UTF8')),'hex')
FROM (SELECT *, 'Synthetic '||loc title,'Synthetic scale fixture item '||i summary,
 '# Synthetic '||loc||chr(10)||chr(10)||repeat('Disposable performance data, no production content. ',16)||
 md5('${seed}:'||i)||chr(10) body FROM scale_rows) r;
-- Same curated fields as buildNodeRevisionSnapshot, with one PRE-EDIT row.
-- Live rev2 and pre-edit rev1 share content (a synthetic metadata-only edit).
-- INSERT triggers compute the live revision fingerprint; generated nodes.tsv stays enabled.
INSERT INTO node_revisions (id,node_id,memory_id,loc,name,alias,description,abstract,abstract_origin_hash,content,tags,
 node_type,object_type,is_link,properties,data,seq,is_runnable,role,llm_model,ai_agent,authorship_kind,
 authored_by_task,authored_by_revision,authored_by_human,authored_at,edited_by_info,rev_label,changes,rev_no,
 approved_by_info,approved_at,approval_hash,created_at)
SELECT md5(n.id||':revision:1'),n.id,n.memory_id,n.loc,n.name,n.alias,n.description,n.abstract,n.abstract_origin_hash,n.content,n.tags,
 n.node_type,n.object_type,n.is_link,n.properties,n.data,n.seq,n.is_runnable,n.role,n.llm_model,n.ai_agent,n.authorship_kind,
 n.authored_by_task,n.authored_by_revision,n.authored_by_human,n.authored_at,'fixture:2899','Synthetic pre-edit snapshot',ARRAY[]::text[],1,
 'fixture:2899','2026-01-01',n.approval_hash,'2026-01-01'
FROM nodes n JOIN scale_rows r ON r.memory_id=n.memory_id AND r.loc=n.loc;
-- Abstract lineage is initialized without altering the revisioned fields.
-- No embedding jobs/vectors: both fixture memories opt out, index stays empty.
DO $verify$ BEGIN
 IF (SELECT count(*) FROM nodes WHERE memory_id='${memory}') <> ${count}
 OR (SELECT count(*) FROM nodes WHERE memory_id='${control}') <> 1 THEN RAISE EXCEPTION 'count mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM nodes WHERE memory_id IN ('${memory}','${control}') AND
 (tsv IS NULL OR approval_hash IS NULL OR revision_content_hash IS DISTINCT FROM hadron_node_revision_state_hash(nodes)))
 THEN RAISE EXCEPTION 'derived field mismatch'; END IF;
 IF (SELECT count(*) FROM node_revisions WHERE memory_id='${memory}') <> ${count}
 THEN RAISE EXCEPTION 'revision count mismatch'; END IF;
END $verify$;
COMMIT;
ANALYZE nodes;
ANALYZE node_revisions;
SELECT jsonb_build_object('fixture','2899','seed','${seed}','count',${count},'memoryId','${memory}','controlId','${control}',
 'databaseBytes',pg_database_size(current_database()),'nodesBytes',pg_total_relation_size('nodes'),
 'revisionsBytes',pg_total_relation_size('node_revisions'),'maxDepth',(SELECT max(1+length(loc)-length(replace(loc,':',''))) FROM nodes WHERE memory_id='${memory}'),
 'embeddings','skipped; vector indexing disabled on fixture memories');
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4 || !/^\d+$/.test(process.argv[2])) throw new Error('usage: node scale-fixture.mjs COUNT [SEED] | stack psql');
    process.stdout.write(fixtureSql(Number(process.argv[2]), process.argv[3]));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
