ALTER TABLE local_server_backups
  ADD COLUMN locked TINYINT UNSIGNED NOT NULL DEFAULT 0,
  MODIFY COLUMN state ENUM('creating','ready','restoring','create_failed','restore_failed','deleting') NOT NULL;
