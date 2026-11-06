-- #3601: escape control data before the structural separator. Keep the old index for old binaries.
CREATE INDEX IF NOT EXISTS nodes_memory_segment_key_v2_idx
  ON nodes (memory_id, ((replace(replace(replace(loc, chr(2), chr(2)||'2'), chr(1), chr(2)||'1'), ':', chr(1))) COLLATE "C"));
