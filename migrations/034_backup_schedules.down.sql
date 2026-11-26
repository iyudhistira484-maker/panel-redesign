ALTER TABLE local_server_backups DROP INDEX scheduled_backup_once, DROP COLUMN schedule_slot;
DROP TABLE backup_schedules;
