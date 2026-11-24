UPDATE wings_provisions SET phase='uncertain' WHERE phase='transferring';
DROP TABLE IF EXISTS wings_transfers;
ALTER TABLE wings_provisions MODIFY phase ENUM('dispatching','installing','installed','install_failed','uncertain','reinstalling','reinstall_uncertain','deleting','delete_uncertain','deleted') NOT NULL;
