-- #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, hrn:node:hadronmemory.com:specs:cor:agt:010:01; Holger, 2026-11-27,
-- decision record 2026-11-27-holger-rulings-to-victor-read-grant-shape-r1, sections 5 and 6):
--   D-a: the unsigned per-automation read grants of #2883 ("Drop them"), and their events (gate decision 2, issue comment 7218964670);
--   D-b: the unsigned App write grants of ruling 0083 ("Drop them too"), and their events.
-- Neither is carried or re-signed: a memory's manager who still wants the read signs a `memory.read` grant, and its owner who still
-- wants the write signs a `memory.write` grant. Reads and writes through the old rows stop at deploy; the server that ships this
-- migration no longer reads either table.
--
-- TRUNCATE, not DELETE: both tables and both event tables refuse a row DELETE by trigger (append-only, see
-- prisma/app-automation-read-grant-invariants.sql and prisma/app-memory-write-grant-invariants.sql), and TRUNCATE fires no row
-- trigger. No CASCADE: nothing references these four tables, and if that ever changes this statement fails loudly instead of
-- emptying another table. The tables, their triggers and their models stay until the doors' deprecation window ends (a separate
-- contract step); until then every door that wrote them refuses, so no row comes back. An older image still running during a
-- blue/green overlap could write a row nothing reads.
--
-- There is no data precondition to refuse on (every row goes), so there is no HDPRF branch. The counts (rows and event rows, for
-- each table) are taken read-only in production before the ready call, and the deploy needs its own register grant per table.
TRUNCATE TABLE
  app_automation_read_grant_events,
  app_automation_read_grants,
  app_memory_write_grant_events,
  app_memory_write_grants;
