SELECT count(*) AS rows, pg_total_relation_size('app_runs') AS bytes FROM app_runs;
