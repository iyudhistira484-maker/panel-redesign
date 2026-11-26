ALTER TABLE local_server_backups ADD COLUMN adapter ENUM('wings','s3') NOT NULL DEFAULT 'wings';
