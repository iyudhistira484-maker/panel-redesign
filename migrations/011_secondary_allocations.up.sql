ALTER TABLE servers ADD UNIQUE KEY servers_node_id_id (node_id,id);
CREATE TABLE server_secondary_allocations (
  allocation_id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  node_id CHAR(36) NOT NULL,
  KEY (server_id),
  FOREIGN KEY (node_id,server_id) REFERENCES servers(node_id,id) ON DELETE CASCADE,
  FOREIGN KEY (node_id,allocation_id) REFERENCES allocations(node_id,id)
) ENGINE=InnoDB;
