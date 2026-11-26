CREATE TABLE backup_schedule_runs (
  server_id CHAR(36) NOT NULL,
  owner_id CHAR(36) NOT NULL,
  node_id CHAR(36) NOT NULL,
  slot DATETIME(3) NOT NULL,
  adapter ENUM('wings','s3') NOT NULL,
  outcome ENUM('reserved','ready','create_failed','not_offline','busy','quota') NOT NULL,
  backup_id CHAR(36),
  finished_at DATETIME(3),
  PRIMARY KEY (server_id,slot),
  UNIQUE KEY scheduled_run_backup_id (backup_id),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
