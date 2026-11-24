CREATE TABLE server_grants (
  server_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  permissions JSON NOT NULL,
  PRIMARY KEY (server_id,user_id),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (JSON_TYPE(permissions) = 'ARRAY')
) ENGINE=InnoDB;
