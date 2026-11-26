ALTER TABLE wings_provisions ADD COLUMN runtime_profile ENUM('standard','diagnostic') NOT NULL DEFAULT 'standard';
