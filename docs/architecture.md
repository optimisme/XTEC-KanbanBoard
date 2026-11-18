# Architecture

This document records the main design decisions and the reasons behind them.

## Layers

```text
routes ─▶ controllers ─▶ services ─▶ repositories ─▶ MySQL
                           │
                           └─ accessService (authorization)
```

- **Routes** only map URLs to controllers and attach coarse role guards.
- **Controllers** translate HTTP to service calls and back. They hold no rules.
- **Services** contain every business rule, input validation and transaction.
- **Repositories** contain all SQL. Each function receives a `db` executor, so
  the same function works on the pool or inside a transaction.

There is no ORM: the schema is small, the queries are explicit, and the
integrity rules live in the database itself.

## Data model

Shared definitions and per-group state are separate tables:

- `task_definitions` — one row per shared task of a project (title, Markdown
  description, acceptance criteria, `sort_order`, `version`).
- `group_tasks` — one row per (group, task definition): state, responsible
  student and completion data. A unique key on `(group_id, task_id)`
  guarantees exactly one instance.

Editing a definition therefore cannot affect progress: the two never share a
row. Creating a task inserts a `group_tasks` row for every existing group;
creating a group inserts a row for every existing task. Both happen in one
transaction that holds a lock on the project row, so a task and a group
created at the same time cannot miss each other.

### Integrity enforced by MySQL

| Rule | Mechanism |
|---|---|
| Group numbers unique per project | `UNIQUE (project_id, group_number)` |
| One group per student and project | `UNIQUE (project_id, user_id)` on `group_students` |
| A group's tasks belong to the group's project | Composite foreign keys through `project_id` |
| The responsible student is a member of the group | `FOREIGN KEY (group_id, responsible_user_id)` → `group_students` |
| At most one responsible student | A single nullable column |
| A task only uses modules of its project | `task_modules (project_id, module_id)` → `project_modules` |
| At most one open block per task | Unique key over a generated column that is `1` while `unblocked_at IS NULL` |
| History is not lost | No `ON DELETE CASCADE` anywhere; projects are archived, tasks are soft-deleted |

### No priority levels

Task priority is the position in `task_definitions.sort_order`, read with
`ORDER BY sort_order ASC, id ASC`. There is no priority column, enum, color or
badge anywhere. Boards filter that single ordered list by state, so every
column of every group shows tasks in the administrator's order.

### No teacher–module relation

Teacher permissions come only from `project_teachers`. Modules are labels
(`project_modules`, `task_modules`). There is deliberately no `teacher_modules`
table, and a test asserts that it does not exist.

## Authorization

`accessService` is the only place that decides who may see or change what:

- **admin** — every project.
- **teacher** — projects listed in `project_teachers`.
- **student** — only the group they belong to.

Every service resolves access through it (`projectAccess`, `groupAccess`,
`groupTaskAccessById`, `managerAccess`). The frontend hides controls the user
cannot use, but that is cosmetic; the API rejects the request regardless.
User identifiers for security decisions always come from the session, never
from the request body.

Archived projects are read-only: every mutating service calls
`assertWritable(project)` and answers `409 project_archived`. Only
unarchiving is allowed.

## Kanban state changes and concurrency

`groupTaskService.changeStatus` runs in a transaction that first locks the
`group_tasks` row (`SELECT … FOR UPDATE`). State change, automatic assignment,
blocking event, timeline comment and history entries are written together.
Two students starting the same task at once are serialized by the lock: the
second request sees the task already in progress and is rejected, so only one
of them becomes responsible.

Clients also send the state they last saw (`expected_status`). If it no longer
matches, the API answers `409 stale_task` and the board reloads, instead of
applying a change on top of someone else's.

The transition policy lives in one function. The API returns
`allowed_transitions` with every task, and the frontend offers exactly those
targets, both for drag-and-drop and for the accessible "Mou a…" control.

Transactions retry automatically on InnoDB deadlocks.

## Responsibility versus contribution

Who is responsible (`group_tasks.responsible_user_id`) and who did something
(`task_history.actor_id`, `completed_by`, comment and attachment authors,
`task_block_events.blocked_by`) are stored separately. The student
contribution view presents them separately, so that being responsible is
never read as proof of having done the work.

`task_history` is append-only: the application only inserts into it.

## Versioning

Every change to a definition's title, description, acceptance criteria or
modules stores a full snapshot in `task_versions` and increments
`task_definitions.version`. Saving without changes creates no version. When a
group completes a task, the current version number is stored with it.

## Authentication and sessions

- OpenID Connect authorization code flow with PKCE, `state` and `nonce`
  (`openid-client`). The ID token is validated by the server.
- Identity is the pair (issuer, subject). The verified email only decides
  whether the account may register (institutional domain).
- New accounts are `pending`; only `active` accounts pass `requireActive`.
  The user is re-read from the database on every request, so disabling an
  account takes effect immediately.
- Sessions are server-side, stored in MySQL, with `HttpOnly`, `SameSite=Lax`
  and (in production) `Secure` cookies. The session id is regenerated at login.
- CSRF: synchronizer token kept in the session and required in the
  `X-CSRF-Token` header for every state-changing request.
- The development login is only registered when `DEV_AUTH_ENABLED=true`, and
  the configuration aborts startup if that is combined with production.

## Markdown and uploads

- Markdown is rendered on the server with `marked` and sanitized with
  `sanitize-html` (tag and attribute allowlists; only `http`, `https` and
  `mailto` URLs). The browser receives ready-to-insert HTML.
- A strict Content Security Policy (`script-src 'self'`, no inline scripts or
  styles) is a second line of defence.
- Uploaded files are limited by extension, size and a content signature
  check, stored under random names in `UPLOAD_DIR` (outside `public/`), and
  served only through an authenticated endpoint with
  `Content-Security-Policy: sandbox` and `nosniff`. Access is checked before
  the file is written to disk.

## Frontend

A single-page application written as plain ES modules with hash routing.
There is no build step: `public/` is served as is. `ui.js` provides a small
element builder; all text is inserted as text nodes, and only
server-sanitized Markdown is inserted as HTML.

## Deployment

`proxmox/` holds the scripts for the institute's Proxmox container
(kanban.ieti.site). The deploy script packages committed files only, never
touches the server's `.env` or `uploads/`, dumps the database before running
migrations and rolls the code back if the health check fails.
