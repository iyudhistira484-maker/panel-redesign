ALTER TABLE s3_fixture_receipts ADD COLUMN upload_expires_at DATETIME(3) NULL;
UPDATE s3_fixture_receipts SET upload_expires_at=CURRENT_TIMESTAMP(3)+INTERVAL 45 SECOND WHERE state IN ('uploading','deleting') AND upload_id IS NOT NULL;
