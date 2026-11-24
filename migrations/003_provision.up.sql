CREATE TABLE wings_provisions (
  server_id CHAR(36) PRIMARY KEY,
  phase ENUM('dispatching','installing','installed','install_failed','uncertain') NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (server_id) REFERENCES servers(id)
) ENGINE=InnoDB;
