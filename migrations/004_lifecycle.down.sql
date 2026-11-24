UPDATE wings_provisions SET phase='uncertain' WHERE phase IN ('reinstalling','reinstall_uncertain','deleting','delete_uncertain','deleted');
ALTER TABLE wings_provisions MODIFY phase ENUM('dispatching','installing','installed','install_failed','uncertain') NOT NULL;
