CREATE TABLE compat_account_profiles (
  user_id CHAR(36) PRIMARY KEY,
  upstream_id INT UNSIGNED NOT NULL UNIQUE,
  username VARCHAR(191) NOT NULL,
  first_name VARCHAR(191),
  last_name VARCHAR(191),
  language VARCHAR(16) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
