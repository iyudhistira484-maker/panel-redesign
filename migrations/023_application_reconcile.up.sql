ALTER TABLE application_keys ADD COLUMN reconcile_servers BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wings_provisions ADD COLUMN application_origin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE wings_provisions p SET p.application_origin=TRUE WHERE EXISTS (SELECT 1 FROM audit_log a WHERE a.subject_id=p.server_id AND a.event='wings.application_provision_requested');
