CREATE TABLE compat_sftp_keys (
  fingerprint BINARY(32) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES compat_account_profiles(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;
