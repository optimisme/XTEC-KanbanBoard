-- An optional short name for a group, shown next to its number.
ALTER TABLE project_groups ADD COLUMN name VARCHAR(40) NULL AFTER group_number;
