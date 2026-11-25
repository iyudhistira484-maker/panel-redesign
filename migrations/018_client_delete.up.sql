ALTER TABLE api_keys ADD COLUMN client_delete_file BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE client_uploaded_files (
  server_id CHAR(36) NOT NULL,
  name VARBINARY(80) NOT NULL,
  digest CHAR(64) NOT NULL,
  PRIMARY KEY (server_id,name),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
