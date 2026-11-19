-- A project can be kept away from its students while it is being prepared.
ALTER TABLE projects ADD COLUMN hidden TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
