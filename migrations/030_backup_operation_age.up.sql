ALTER TABLE local_server_backups ADD COLUMN operation_started_at DATETIME(3) NULL;
UPDATE local_server_backups SET operation_started_at=CURRENT_TIMESTAMP(3) WHERE state IN ('creating','restoring');
