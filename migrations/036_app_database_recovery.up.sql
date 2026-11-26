CREATE TABLE app_database_bindings (
  id CHAR(36) PRIMARY KEY,
  server_id CHAR(36) NOT NULL,
  label VARCHAR(80) NOT NULL,
  recovery_state ENUM('empty','restoring','restored','needs_review') NOT NULL DEFAULT 'empty',
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE app_database_backups (
  id CHAR(36) PRIMARY KEY,
  database_id CHAR(36) NOT NULL,
  state ENUM('creating','ready','failed') NOT NULL,
  size_bytes INT UNSIGNED,
  sha256 CHAR(64),
  dump MEDIUMBLOB,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (database_id,created_at),
  FOREIGN KEY (database_id) REFERENCES app_database_bindings(id) ON DELETE CASCADE
) ENGINE=InnoDB;
