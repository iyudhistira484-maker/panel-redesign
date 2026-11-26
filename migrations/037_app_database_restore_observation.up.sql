ALTER TABLE app_database_bindings
  ADD COLUMN recovery_backup_id CHAR(36),
  ADD COLUMN recovery_started_at DATETIME(3),
  ADD COLUMN recovery_finished_at DATETIME(3);
