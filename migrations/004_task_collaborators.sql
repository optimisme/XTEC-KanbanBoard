-- Students who work on a group task together with its responsible student.
ALTER TABLE group_tasks ADD UNIQUE KEY uq_group_tasks_id_group (id, group_id);

CREATE TABLE task_collaborators (
  group_task_id INT UNSIGNED NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  added_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_task_id, user_id),
  KEY idx_task_collaborators_user (user_id),
  KEY idx_task_collaborators_member (group_id, user_id),
  -- The task belongs to that group ...
  CONSTRAINT fk_task_collaborators_task FOREIGN KEY (group_task_id, group_id)
    REFERENCES group_tasks (id, group_id),
  -- ... and a collaborator must be a member of the same group.
  CONSTRAINT fk_task_collaborators_member FOREIGN KEY (group_id, user_id)
    REFERENCES group_students (group_id, user_id),
  CONSTRAINT fk_task_collaborators_added_by FOREIGN KEY (added_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
