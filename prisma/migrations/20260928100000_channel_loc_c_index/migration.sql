-- #1430: C-collation btree for channel-message keyset pages. The locale
-- index cannot serve a collation-independent prefix range (en_US orders
-- ':' and ';' by locale rules, not bytes), so the paged attention scan
-- gets a byte-order index over (memory_id, loc COLLATE "C").
CREATE INDEX "nodes_memory_id_loc_c_idx" ON "nodes" ("memory_id", "loc" COLLATE "C");
