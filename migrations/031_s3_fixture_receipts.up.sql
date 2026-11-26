CREATE TABLE s3_fixture_receipts (
  id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  node_id CHAR(36) NOT NULL,
  state ENUM('reserved','allocating','uploading','completing','ready','deleting') NOT NULL DEFAULT 'reserved',
  upload_id VARCHAR(1024),
  size_bytes INT UNSIGNED,
  checksum CHAR(40),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE RESTRICT,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
