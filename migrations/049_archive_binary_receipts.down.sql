DELETE FROM client_uploaded_files WHERE name LIKE 'extract-%/%.bin';
ALTER TABLE client_uploaded_files MODIFY name VARBINARY(80) NOT NULL;
