CREATE TABLE backup_schedules (
  server_id CHAR(36) PRIMARY KEY,
  owner_id CHAR(36) NOT NULL,
  node_id CHAR(36) NOT NULL,
  adapter ENUM('wings','s3') NOT NULL,
  interval_minutes SMALLINT UNSIGNED NOT NULL,
  keep_count TINYINT UNSIGNED NOT NULL,
  next_run_at DATETIME(3) NOT NULL,
  last_result VARCHAR(32),
  INDEX (next_run_at),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
ALTER TABLE local_server_backups ADD COLUMN schedule_slot DATETIME(3), ADD UNIQUE KEY scheduled_backup_once (server_id,schedule_slot);
