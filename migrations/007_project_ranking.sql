-- Whether the students of a project can see the ranking of its groups.
ALTER TABLE projects ADD COLUMN ranking_visible TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
