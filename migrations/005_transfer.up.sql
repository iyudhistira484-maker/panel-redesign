ALTER TABLE wings_provisions MODIFY phase ENUM('dispatching','installing','installed','install_failed','uncertain','reinstalling','reinstall_uncertain','deleting','delete_uncertain','deleted','transferring') NOT NULL;
CREATE TABLE wings_transfers (
  id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  source_node_id CHAR(36) NOT NULL,
  source_allocation_id CHAR(36) NOT NULL,
  target_node_id CHAR(36) NOT NULL,
  target_allocation_id CHAR(36) NOT NULL,
  phase ENUM('reserved','uncertain','completed','cancelled') NOT NULL,
  active_server CHAR(36) GENERATED ALWAYS AS (CASE WHEN phase IN ('reserved','uncertain') THEN server_id END) STORED UNIQUE,
  active_allocation CHAR(36) GENERATED ALWAYS AS (CASE WHEN phase IN ('reserved','uncertain') THEN target_allocation_id END) STORED UNIQUE,
  FOREIGN KEY (server_id) REFERENCES servers(id),
  FOREIGN KEY (source_node_id,source_allocation_id) REFERENCES allocations(node_id,id),
  FOREIGN KEY (target_node_id,target_allocation_id) REFERENCES allocations(node_id,id),
  CHECK (source_node_id <> target_node_id)
) ENGINE=InnoDB;
