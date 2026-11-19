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
  description, `sort_order`, `version`).
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
| A task only uses tags of its own project | `task_tags (tag_id, project_id)` → `project_tags (id, project_id)` |
| Tag names are unique inside a project | `UNIQUE (project_id, name)` on `project_tags` |
| At most one open block per task | Unique key over a generated column that is `1` while `unblocked_at IS NULL` |
| History is not lost by accident | Projects are archived and tasks soft-deleted in normal use. The only hard delete is an administrator erasing a whole project that has already been archived, done explicitly table by table |

### No priority levels

Task priority is the position in `task_definitions.sort_order`, read with
`ORDER BY sort_order ASC, id ASC`. There is no priority column, enum, color or
badge anywhere. Boards filter that single ordered list by state, so the
columns of every group show tasks in the order set by the project's managers. The one
exception is the *Finalitzat* column, which is display-only history: it lists
tasks in the order they were completed (`completed_at`, oldest first) and
shows the completion date on each card.

### Tags never grant access

Teacher permissions come only from `project_teachers`. Tags (`project_tags`,
`task_tags`) are free labels owned by a project: they classify and color
tasks and are never consulted for authorization. Tasks send tag *names*; the
service reuses the project's tag with that name or creates it in the same
transaction that saves the task.

## Authorization

`accessService` is the only place that decides who may see or change what:

- **admin** — every project.
- **teacher** — projects listed in `project_teachers`. Inside those projects a
  teacher has the same powers as an administrator (edit, tasks and their
  order, import, groups, students, archive, duplicate). A teacher can add a
  colleague who already has a teacher account, but cannot remove teachers or
  create teacher accounts. Creating a project assigns its creator.
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
(`task_history.actor_id`, `completed_by`, comment authors,
`task_block_events.blocked_by`) are stored separately. The student
contribution view presents them separately, so that being responsible is
never read as proof of having done the work.

`task_history` is append-only: the application only inserts into it.

## Versioning

Every change to a definition's title, description or tags stores a full snapshot in `task_versions` and increments
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
- Optional passwords are stored as salted scrypt hashes
  (`scrypt$N$r$p$salt$hash`) and compared in constant time. A sign-in attempt
  for an unknown email runs the same computation, and repeated failures lock
  the client address out for a while.
- CSRF: synchronizer token kept in the session and required in the
  `X-CSRF-Token` header for every state-changing request.
- The development login is only registered when `DEV_AUTH_ENABLED=true`, and
  the configuration aborts startup if that is combined with production.

## Markdown

- Markdown is rendered on the server with `marked` and sanitized with
  `sanitize-html` (tag and attribute allowlists; only `http`, `https` and
  `mailto` URLs). The browser receives ready-to-insert HTML.
- A strict Content Security Policy (`script-src 'self'`, no inline scripts or
  styles) is a second line of defence.

## Frontend

A single-page application written as plain ES modules with hash routing.
There is no build step: `public/` is served as is, under
`/static/<fingerprint>/`, where the fingerprint is a hash of the frontend
files computed at startup. `index.html` is never cached and points at the
current fingerprint, so a deploy is visible immediately even behind a CDN
that caches scripts and styles for hours. `ui.js` provides a small
element builder; all text is inserted as text nodes, and only
server-sanitized Markdown is inserted as HTML.

## Deployment

`proxmox/` holds the scripts for the institute's Proxmox container
(kanban.ieti.site). The deploy script packages committed files only, never
touches the server's `.env`, dumps the database before running
migrations and rolls the code back if the health check fails.
