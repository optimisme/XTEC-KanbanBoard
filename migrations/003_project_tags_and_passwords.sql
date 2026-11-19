-- Professional modules become tags that belong to one project. Each project
-- keeps the modules it used as its own tags, and tasks keep their labels.
CREATE TABLE project_tags (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  color CHAR(7) NOT NULL,
  text_color CHAR(7) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_tags_name (project_id, name),
  -- Target of the composite foreign key that keeps a task's tags in its own project.
  UNIQUE KEY uq_project_tags_id_project (id, project_id),
  CONSTRAINT fk_project_tags_project FOREIGN KEY (project_id) REFERENCES projects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO project_tags (project_id, name, color, text_color)
SELECT pm.project_id, m.name, m.color, m.text_color
  FROM project_modules pm JOIN modules m ON m.id = pm.module_id;

CREATE TABLE task_tags (
  task_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (task_id, tag_id),
  KEY idx_task_tags_tag (tag_id, project_id),
  CONSTRAINT fk_task_tags_task FOREIGN KEY (task_id, project_id)
    REFERENCES task_definitions (id, project_id),
  -- Deleting a tag simply removes it from the tasks that had it.
  CONSTRAINT fk_task_tags_tag FOREIGN KEY (tag_id, project_id)
    REFERENCES project_tags (id, project_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO task_tags (task_id, project_id, tag_id)
SELECT tm.task_id, tm.project_id, pt.id
  FROM task_modules tm
  JOIN modules m ON m.id = tm.module_id
  JOIN project_tags pt ON pt.project_id = tm.project_id AND pt.name = m.name;

DROP TABLE task_modules;
DROP TABLE project_modules;
DROP TABLE modules;

ALTER TABLE task_versions RENAME COLUMN modules TO tags;

-- Optional password for people who prefer not to use the identity provider.
-- Only a salted scrypt hash is stored, never the password itself.
ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL AFTER name;
