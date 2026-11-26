CREATE TABLE local_server_backups (
  id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  node_id CHAR(36) NOT NULL,
  state ENUM('creating','ready','restoring','create_failed','restore_failed') NOT NULL,
  size_bytes INT UNSIGNED,
  checksum CHAR(40),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (server_id,created_at),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
