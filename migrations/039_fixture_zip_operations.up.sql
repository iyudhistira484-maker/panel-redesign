CREATE TABLE fixture_zip_operations (
  server_id CHAR(36) NOT NULL PRIMARY KEY,
  operation_id CHAR(32) NOT NULL,
  status ENUM('pending','succeeded','retryable') NOT NULL,
  manifest JSON NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
