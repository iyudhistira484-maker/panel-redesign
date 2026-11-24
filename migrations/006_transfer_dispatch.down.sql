UPDATE wings_transfers SET phase='uncertain' WHERE phase='reserved' AND dispatched_at IS NOT NULL;
ALTER TABLE wings_transfers DROP COLUMN destination_reported_at, DROP COLUMN dispatched_at;
