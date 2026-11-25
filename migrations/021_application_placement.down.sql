ALTER TABLE application_keys DROP COLUMN read_nodes, DROP COLUMN read_allocations;
ALTER TABLE allocations DROP COLUMN application_id;
ALTER TABLE nodes DROP COLUMN application_id;
