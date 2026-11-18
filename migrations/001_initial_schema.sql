-- Educational Kanban: initial schema.
-- Task priority is the position in task_definitions.sort_order. There are no
-- priority levels, and teacher access is granted only through project_teachers.

CREATE TABLE users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- NULL until the first institutional login binds the identity
  -- (accounts pre-created with the create-admin script).
  oidc_issuer VARCHAR(255) NULL,
  oidc_subject VARCHAR(255) NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(200) NOT NULL,
  role ENUM('admin', 'teacher', 'student') NOT NULL DEFAULT 'student',
  status ENUM('pending', 'active', 'rejected', 'disabled') NOT NULL DEFAULT 'pending',
  last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_identity (oidc_issuer, oidc_subject),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status_role (status, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE modules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  color CHAR(7) NOT NULL,
  text_color CHAR(7) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_modules_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE projects (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  academic_year VARCHAR(9) NOT NULL,
  status ENUM('active', 'archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_projects_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_teachers (
  project_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  KEY idx_project_teachers_user (user_id),
  CONSTRAINT fk_project_teachers_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_project_teachers_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_modules (
  project_id INT UNSIGNED NOT NULL,
  module_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (project_id, module_id),
  KEY idx_project_modules_module (module_id),
  CONSTRAINT fk_project_modules_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_project_modules_module FOREIGN KEY (module_id) REFERENCES modules (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_groups (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  group_number INT UNSIGNED NOT NULL,
  github_url VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_groups_number (project_id, group_number),
  -- Target of composite foreign keys that tie child rows to the same project.
  UNIQUE KEY uq_project_groups_id_project (id, project_id),
  CONSTRAINT fk_project_groups_project FOREIGN KEY (project_id) REFERENCES projects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_students (
  group_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  -- A student belongs to at most one group per project.
  UNIQUE KEY uq_group_students_project_user (project_id, user_id),
  KEY idx_group_students_user (user_id),
  CONSTRAINT fk_group_students_group FOREIGN KEY (group_id, project_id)
    REFERENCES project_groups (id, project_id),
  CONSTRAINT fk_group_students_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_definitions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  -- Global position in the project task list. This is the only notion of priority.
  sort_order INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  -- Soft deletion keeps group progress and history intact.
  deleted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_definitions_id_project (id, project_id),
  KEY idx_task_definitions_order (project_id, sort_order, id),
  CONSTRAINT fk_task_definitions_project FOREIGN KEY (project_id) REFERENCES projects (id),
  CONSTRAINT fk_task_definitions_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_modules (
  task_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  module_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (task_id, module_id),
  KEY idx_task_modules_project_module (project_id, module_id),
  CONSTRAINT fk_task_modules_task FOREIGN KEY (task_id, project_id)
    REFERENCES task_definitions (id, project_id),
  -- A task can only use modules associated with its own project.
  CONSTRAINT fk_task_modules_project_module FOREIGN KEY (project_id, module_id)
    REFERENCES project_modules (project_id, module_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_versions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id INT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  modules JSON NOT NULL,
  modified_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_versions (task_id, version),
  CONSTRAINT fk_task_versions_task FOREIGN KEY (task_id) REFERENCES task_definitions (id),
  CONSTRAINT fk_task_versions_user FOREIGN KEY (modified_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_tasks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id INT UNSIGNED NOT NULL,
  task_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'in_progress', 'blocked', 'completed') NOT NULL DEFAULT 'pending',
  responsible_user_id INT UNSIGNED NULL,
  assigned_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  completed_by INT UNSIGNED NULL,
  completed_version INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Exactly one instance of each task definition per group.
  UNIQUE KEY uq_group_tasks (group_id, task_id),
  KEY idx_group_tasks_task (task_id),
  KEY idx_group_tasks_project_status (project_id, status),
  KEY idx_group_tasks_responsible (responsible_user_id),
  CONSTRAINT fk_group_tasks_group FOREIGN KEY (group_id, project_id)
    REFERENCES project_groups (id, project_id),
  CONSTRAINT fk_group_tasks_task FOREIGN KEY (task_id, project_id)
    REFERENCES task_definitions (id, project_id),
  -- The responsible student must be a member of the same group.
  CONSTRAINT fk_group_tasks_responsible FOREIGN KEY (group_id, responsible_user_id)
    REFERENCES group_students (group_id, user_id),
  CONSTRAINT fk_group_tasks_completed_by FOREIGN KEY (completed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_task_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  content TEXT NOT NULL,
  type ENUM('comment', 'block', 'unblock') NOT NULL DEFAULT 'comment',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_comments_task (group_task_id, created_at),
  KEY idx_task_comments_author (author_id),
  CONSTRAINT fk_task_comments_task FOREIGN KEY (group_task_id) REFERENCES group_tasks (id),
  CONSTRAINT fk_task_comments_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_attachments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_task_id INT UNSIGNED NOT NULL,
  author_id INT UNSIGNED NOT NULL,
  kind ENUM('file', 'link', 'github_commit', 'github_pull_request') NOT NULL,
  title VARCHAR(255) NOT NULL,
  url VARCHAR(1000) NULL,
  stored_name VARCHAR(100) NULL,
  mime_type VARCHAR(120) NULL,
  size_bytes INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_attachments_task (group_task_id, created_at),
  KEY idx_task_attachments_author (author_id),
  CONSTRAINT fk_task_attachments_task FOREIGN KEY (group_task_id) REFERENCES group_tasks (id),
  CONSTRAINT fk_task_attachments_author FOREIGN KEY (author_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_block_events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_task_id INT UNSIGNED NOT NULL,
  reason TEXT NOT NULL,
  blocked_by INT UNSIGNED NOT NULL,
  blocked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unblocked_by INT UNSIGNED NULL,
  unblocked_at TIMESTAMP NULL,
  duration_seconds INT UNSIGNED NULL,
  -- 1 while the block is open, NULL once closed: at most one open block per task.
  active_marker TINYINT GENERATED ALWAYS AS (IF(unblocked_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_task_block_events_active (group_task_id, active_marker),
  KEY idx_task_block_events_blocked_by (blocked_by),
  CONSTRAINT fk_task_block_events_task FOREIGN KEY (group_task_id) REFERENCES group_tasks (id),
  CONSTRAINT fk_task_block_events_blocked_by FOREIGN KEY (blocked_by) REFERENCES users (id),
  CONSTRAINT fk_task_block_events_unblocked_by FOREIGN KEY (unblocked_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only: the application only ever inserts into this table.
CREATE TABLE task_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_task_id INT UNSIGNED NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  old_value VARCHAR(255) NULL,
  new_value VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_history_task (group_task_id, id),
  KEY idx_task_history_actor (actor_id, id),
  CONSTRAINT fk_task_history_task FOREIGN KEY (group_task_id) REFERENCES group_tasks (id),
  CONSTRAINT fk_task_history_actor FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Persistent server-side session store (express-mysql-session layout).
CREATE TABLE sessions (
  session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
) ENGINE=InnoDB;
