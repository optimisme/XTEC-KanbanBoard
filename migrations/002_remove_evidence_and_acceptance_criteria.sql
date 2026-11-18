-- Evidence (links and uploaded files) is no longer part of the application.
DELETE FROM task_history WHERE event_type = 'evidence_uploaded';
DROP TABLE IF EXISTS task_attachments;

-- Task definitions keep a single Markdown description.
ALTER TABLE task_definitions DROP COLUMN acceptance_criteria;
ALTER TABLE task_versions DROP COLUMN acceptance_criteria;
