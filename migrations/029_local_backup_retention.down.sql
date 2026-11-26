UPDATE local_server_backups SET state='create_failed' WHERE state='deleting';
ALTER TABLE local_server_backups
  DROP COLUMN locked,
  MODIFY COLUMN state ENUM('creating','ready','restoring','create_failed','restore_failed') NOT NULL;
