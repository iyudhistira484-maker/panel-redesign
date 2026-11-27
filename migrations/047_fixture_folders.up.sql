CREATE TABLE fixture_folders (
  server_id CHAR(36) NOT NULL,
  name VARBINARY(48) NOT NULL,
  PRIMARY KEY (server_id,name),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
