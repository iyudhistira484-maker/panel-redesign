DELETE FROM fixture_folders WHERE name LIKE '%/%';
ALTER TABLE fixture_folders MODIFY name VARBINARY(48) NOT NULL;
