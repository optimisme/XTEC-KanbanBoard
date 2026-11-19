-- The address where a group publishes its work, next to its repository.
ALTER TABLE project_groups ADD COLUMN web_url VARCHAR(500) NULL AFTER github_url;
