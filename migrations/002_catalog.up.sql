CREATE TABLE nodes (
  id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, origin VARCHAR(80) NOT NULL UNIQUE,
  token_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  token_cipher VARBINARY(512) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE nests (
  id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;
CREATE TABLE eggs (
  id CHAR(36) PRIMARY KEY, nest_id CHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
  version ENUM('PTDL_v1','PTDL_v2') NOT NULL, document MEDIUMBLOB NOT NULL,
  UNIQUE (nest_id,name), FOREIGN KEY (nest_id) REFERENCES nests(id)
) ENGINE=InnoDB;
CREATE TABLE allocations (
  id CHAR(36) PRIMARY KEY, node_id CHAR(36) NOT NULL,
  ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  port SMALLINT UNSIGNED NOT NULL CHECK (port > 0),
  UNIQUE (node_id,ip,port), UNIQUE (node_id,id), FOREIGN KEY (node_id) REFERENCES nodes(id)
) ENGINE=InnoDB;
CREATE TABLE servers (
  id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, node_id CHAR(36) NOT NULL,
  owner_id CHAR(36) NOT NULL, egg_id CHAR(36) NOT NULL, allocation_id CHAR(36) NOT NULL UNIQUE,
  status ENUM('draft') NOT NULL DEFAULT 'draft',
  FOREIGN KEY (owner_id) REFERENCES users(id), FOREIGN KEY (egg_id) REFERENCES eggs(id),
  FOREIGN KEY (node_id,allocation_id) REFERENCES allocations(node_id,id)
) ENGINE=InnoDB;
