-- Local development only: one database for the app, one for the tests.
CREATE DATABASE IF NOT EXISTS kanban_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS kanban_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
