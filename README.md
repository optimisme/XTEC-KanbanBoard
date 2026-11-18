# Educational Kanban

A Kanban management application for vocational training institutes. Teachers
define the tasks of a project once; every project group gets the same tasks,
in the same order, and tracks its own progress on an independent board.

- **Administrators** manage users, professional modules, projects, groups and the global task order.
- **Teachers** supervise every group of the projects they are assigned to.
- **Students** work on their own group's board.

The user interface is entirely in **Catalan**. Code, database and documentation are in English.

## Contents

1. [Technology stack](#technology-stack)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Database](#database)
5. [Configuration (.env)](#configuration-env)
6. [Institutional OAuth setup](#institutional-oauth-setup)
7. [Initial administrator](#initial-administrator)
8. [Development server](#development-server)
9. [Running tests](#running-tests)
10. [Production deployment](#production-deployment)
11. [User roles](#user-roles)
12. [Task states and assignment](#task-states-and-assignment)
13. [Markdown import](#markdown-import)
14. [Project duplication](#project-duplication)
15. [REST API overview](#rest-api-overview)
16. [Repository structure](#repository-structure)

Architecture decisions are documented in [docs/architecture.md](docs/architecture.md).

## Technology stack

| Layer | Technology |
|---|---|
| Backend | Node.js (ES modules) + Express 5 |
| Database | MySQL 8, InnoDB, accessed with `mysql2` and parameterized queries |
| Authentication | OpenID Connect (`openid-client`): Google Workspace or Microsoft Entra ID |
| Sessions | `express-session` stored in MySQL (`express-mysql-session`) |
| Frontend | HTML, CSS and vanilla JavaScript modules (no framework, no build step) |
| Markdown | `marked` + `sanitize-html` (rendered and sanitized on the server) |
| Tests | Node.js test runner (`node --test`) + `supertest` |

## Requirements

- Node.js 20.12 or newer
- MySQL 8 (a ready-to-use Docker setup is included for local work)
- An OpenID Connect client (Google Workspace or Microsoft Entra ID) for real logins

## Installation

```bash
npm install
cp .env.example .env      # then edit .env (see below)
```

## Database

### Local MySQL with Docker

```bash
docker compose up -d
```

This starts MySQL 8.4 on `127.0.0.1:3307` with two empty databases, `kanban_dev`
and `kanban_test` (root password `kanban_root_test`, local use only). Matching
`.env` values:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3307
DB_NAME=kanban_dev
DB_USER=root
DB_PASSWORD=kanban_root_test
```

### Existing MySQL server

```sql
CREATE DATABASE kanban CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'kanban'@'localhost' IDENTIFIED BY '<a strong password>';
GRANT ALL PRIVILEGES ON kanban.* TO 'kanban'@'localhost';
```

### Migrations

```bash
npm run migrate
```

Applies every pending file in `migrations/` (tracked in the `schema_migrations`
table). Run it after installing and after every update.

## Configuration (.env)

All deployment-specific and secret values live in `.env`, which is ignored by
Git. `.env.example` lists every variable. The server validates the
configuration at startup and refuses to start when something is missing.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development`, `production` or `test` |
| `PORT`, `APP_URL` | Listening port and public base URL |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection |
| `OIDC_PROVIDER` | `google` or `microsoft` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Identity provider client |
| `OIDC_CALLBACK_URL` | Registered redirect URI. The callback route is served on its path |
| `ALLOWED_EMAIL_DOMAIN` | Institutional domain(s), comma separated |
| `INITIAL_ADMIN_EMAIL` | Account that becomes administrator on its first login |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Optional administrator with password login |
| `SESSION_SECRET` | At least 32 random characters |
| `DEV_AUTH_ENABLED` | Development-only login (see below) |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Functional configuration, such as module colors, is stored in MySQL.

## Institutional OAuth setup

Only accounts whose **verified** email belongs to `ALLOWED_EMAIL_DOMAIN` can
register. The email and the stable subject identifier are always taken from
the ID token validated by the server, never from the browser.

### Google Workspace

1. In Google Cloud Console create an **OAuth client ID** of type *Web application*.
2. Add the redirect URI, for example `https://kanban.ieti.site/auth/google/callback`.
3. Configure:

```dotenv
OIDC_PROVIDER=google
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_CALLBACK_URL=https://kanban.ieti.site/auth/google/callback
ALLOWED_EMAIL_DOMAIN=xtec.cat,iesesteveterradas.cat
```

Google accounts must have `email_verified` set, and the hosted domain (`hd`),
when present, must be one of the allowed domains.

### Microsoft Entra ID

1. Register an application (single tenant) and add a *Web* redirect URI.
2. Create a client secret.
3. Configure:

```dotenv
OIDC_PROVIDER=microsoft
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_CALLBACK_URL=https://kanban.example/auth/callback
```

The issuer must be tenant-specific (`common`, `organizations` and `consumers`
are rejected). The account's user principal name is used as its email.

### Development login

When no identity provider is available, set `DEV_AUTH_ENABLED=true` in a
non-production `.env`. The login form then signs in any email of the allowed
domains without a password, following exactly the same registration and
approval rules. It is the same single form used by the administrator account:
an email is treated as a development account, anything else as the
administrator's username. **The server refuses to start with `DEV_AUTH_ENABLED=true` and
`NODE_ENV=production`**, and the route does not exist in production.

## Initial administrator

Every new account starts as *pending* and needs an administrator. There are
two ways to get the first one:

- **Environment variable**: set `INITIAL_ADMIN_EMAIL=name@institute.example`.
  That account becomes an active administrator on its first institutional login.
- **Command line** (on the server, with access to the database):

  ```bash
  npm run create-admin -- name@institute.example
  ```

  The account is created (or promoted) as an active administrator and is bound
  to the institutional identity the first time it logs in.

- **Username and password** (optional): set `ADMIN_USERNAME` and
  `ADMIN_PASSWORD` in `.env`. The login form then accepts that username and
  password and signs in as a built-in administrator, without the identity
  provider. Leave both variables empty to disable it.
  - The account is always an active administrator; it cannot be locked out
    from the user screen.
  - In production the server refuses to start unless the password has at
    least 12 characters and does not contain the username.
  - After 5 failed attempts an address is locked out for 15 minutes.

Further administrators are appointed from **Usuaris** inside the application.

### Adding people in advance

An administrator can add a person from **Usuaris → Afegeix un usuari** with
their name, institutional email and role. The account is active immediately
and can already be assigned to projects and groups. When that person signs in
with the identity provider for the first time, the verified email links the
account to their identity, so they get in without the approval step. People
who are not added in advance still start as *pending*.

## Development server

```bash
docker compose up -d      # local MySQL
npm run migrate
npm run dev               # restarts on file changes
```

Open <http://localhost:3000>.

## Running tests

Tests use their own database and their own configuration file, `.env.test`
(ignored by Git). The configuration **refuses to run tests unless `DB_NAME`
ends in `_test`**, so tests can never touch real data.

Create `.env.test`:

```dotenv
NODE_ENV=test
PORT=3999
APP_URL=http://localhost:3999
DB_HOST=127.0.0.1
DB_PORT=3307
DB_NAME=kanban_test
DB_USER=root
DB_PASSWORD=kanban_root_test
ALLOWED_EMAIL_DOMAIN=xtec.cat,iesesteveterradas.cat
SESSION_SECRET=test-session-secret-test-session-secret-0000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=test-admin-password
DEV_AUTH_ENABLED=true
```

Then:

```bash
docker compose up -d
npm test
```

The suite applies the migrations, empties the test database and covers the
business rules: approval flow, project and group access, shared task
propagation, global ordering, automatic assignment, transfers, blocking,
completion and reopening, Markdown import, versioning, duplication, archived
projects and concurrent updates.

## Production deployment

General requirements:

1. `NODE_ENV=production`, a strong `SESSION_SECRET`, real `OIDC_*` values and `DEV_AUTH_ENABLED=false`.
   While the identity provider credentials are not available, the server also
   starts with only `ADMIN_USERNAME` and `ADMIN_PASSWORD` set; then only the
   administrator can sign in.
2. Serve the application behind an HTTPS reverse proxy. Session cookies are
   `Secure` in production and the app trusts one proxy hop (`X-Forwarded-*`).
3. `npm ci --omit=dev`, `npm run migrate`, then `npm start` under a process manager.
4. Back up the MySQL database regularly.

### kanban.ieti.site (Proxmox)

The `proxmox/` folder contains the deployment scripts for the institute's
Proxmox container.

1. Copy `proxmox/config.env.example` to `proxmox/config.env` and set the SSH
   port and user of the **kanban** container. `config.env` is ignored by Git.
2. Create the server's configuration from `.env.example` in a local file named
   `kanban.env` (do not commit it) and send it:

   ```bash
   cd proxmox && ./proxmoxSendFile.sh ../kanban.env
   ```

3. Prepare the server once. It installs what is missing (MySQL, curl, Node.js,
   pm2) and creates the database and MySQL user named in `kanban.env`. The
   server asks for the sudo password in your terminal:

   ```bash
   cd proxmox && ./proxmoxInstall.sh
   ```

4. Deploy the committed and pushed `main` branch:

   ```bash
   cd proxmox && ./proxmoxDeploy.sh
   ```

   The script packages only committed files, keeps the server's `.env`, dumps the database before migrating, runs the migrations,
   restarts the app with pm2, checks `/health` and rolls the code back if the
   new version does not start. `DEPLOY_DRY_RUN=1 ./proxmoxDeploy.sh` only
   builds and verifies the package. If `~/nodejs_server` already holds a different
   application, the deploy stops; `DEPLOY_REPLACE_EXISTING=1 ./proxmoxDeploy.sh`
   moves that application aside and installs this one.

| Script | Purpose |
|---|---|
| `proxmoxInstall.sh` | One-time server preparation (asks for the sudo password) |
| `proxmoxDeploy.sh` | Deploy `main` with backup, migrations and health check |
| `proxmoxBackup.sh` | Download a database dump and the server `.env` into `backups/` |
| `proxmoxConnect.sh` | Open an SSH session |
| `proxmoxSendFile.sh` | Copy one file to the server |
| `proxmoxSetupRedirect80.sh` / `proxmoxSetupRedirectUndo.sh` | Redirect port 80 to the app port |
| `proxmoxTunelStart.sh` / `Status` / `Stop` | SSH tunnel to the server's MySQL on local port 3308 |

## User roles

| Capability | Admin | Teacher (assigned project) | Student (own group) |
|---|:-:|:-:|:-:|
| Manage users, modules, projects, groups, teachers | ✔ | | |
| Reorder shared tasks, import from Markdown, duplicate, archive | ✔ | | |
| Create and edit shared task definitions | ✔ | ✔ | |
| View every group, matrix, blocked tasks, student activity | ✔ | ✔ | |
| Change any task state, reassign responsibility | ✔ | ✔ | |
| Move tasks along the board, block and unblock, complete | ✔ | ✔ | ✔ |
| Comment on tasks | ✔ | ✔ | ✔ |
| Transfer one's own tasks to a group member | | | ✔ |
| Configure the group's GitHub repository URL | ✔ | | ✔ |

Teacher access depends **only** on project assignment (`project_teachers`).
Professional modules categorize and color tasks; they never grant or restrict
permissions. Every rule is enforced by the backend.

## Task states and assignment

States: `pending` (Pendent), `in_progress` (En curs), `blocked` (Bloquejat) and
`completed` (Finalitzat). Each group has its own state for every shared task.

Student transitions:

```text
pending ──▶ in_progress ──▶ completed
               ▲  │  ▲           │
               │  ▼  └───────────┘  (reopen)
               │ blocked
               └── pending (back)
```

Teachers and administrators can also correct a task to any other state.

- **Priority is the position in the project's task list.** There are no
  priority levels. Only administrators reorder; all boards follow that order.
  The *Finalitzat* column is the exception: it shows tasks in the order they
  were completed, with the completion date on each card.
- **Automatic assignment**: when a student moves an unassigned task to
  *En curs* they become its responsible student, atomically with the state
  change. Teachers and administrators never become responsible this way.
- A task has **at most one** responsible student, who stays responsible
  through blocking, completion and reopening.
- **Transfers**: the responsible student can hand the task to another member
  of the group. Teachers and administrators can reassign or unassign.
- **Completion**: any member of the group can complete a task. The person who
  completed it is recorded separately from the responsible student, together
  with the definition version at that moment.
- **Blocking** requires a reason. Each block is stored as an event with who
  blocked, who unblocked, when, and for how long. Previous events are kept.
- Every action is appended to the task's activity history.

## Markdown import

Administrators can import the initial task list from Markdown **only while
the project has no tasks**. The project's *Tasques* tab offers the import and
a downloadable template; [examples/tasks-example.md](examples/tasks-example.md)
shows the format:

```markdown
## Create GitHub Repository

**Modules:** Programming

### Description

Create the group's GitHub repository.

- The repository exists.
```

- Each `##` heading is a task; document order becomes the global order.
- `**Modules:**` lists one or more modules already associated with the project.
- Everything else under the task is its Markdown description. The
  `### Description` heading is optional (the Catalan `**Mòduls:**` and
  `### Descripció` are accepted too).
- A preview shows the tasks, their order, modules, errors and warnings.
- The import is atomic: with any error, nothing is created.

## Project duplication

From a project's *Configuració* tab an administrator can duplicate it for
another academic year. The copy receives the name and description (editable),
the module associations, the shared tasks, their modules and their order. It
does **not** receive teachers, groups, students, repository URLs, task states,
responsible students, comments, blocking events or history.

## REST API overview

All endpoints are under `/api`, return JSON, and report errors as
`{ "error": { "code", "message", "details"? } }`. State-changing requests need
the `X-CSRF-Token` header (the token comes from `GET /api/session`).

| Area | Endpoints |
|---|---|
| Authentication | `GET /auth/login`, `GET <callback path>`, `POST /auth/admin-login`, `POST /auth/logout`, `GET /api/session` |
| Users | `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `POST /api/users/:id/approve`, `POST /api/users/:id/reject`, `PATCH /api/profile` |
| Modules | `GET/POST /api/modules`, `PUT/DELETE /api/modules/:id` |
| Projects | `GET/POST /api/projects`, `GET/PUT /api/projects/:id`, `POST …/archive`, `POST …/unarchive`, `POST …/duplicate`, `PUT …/teachers` |
| Groups | `POST /api/projects/:id/groups`, `PUT /api/groups/:id/students`, `DELETE /api/groups/:id`, `PUT /api/groups/:id/github`, `GET /api/groups/:id/board` |
| Shared tasks | `GET/POST /api/projects/:id/tasks`, `PUT /api/projects/:id/tasks/order`, `GET/PUT/DELETE /api/tasks/:id`, `GET /api/tasks/:id/versions` |
| Import | `GET /api/projects/:id/import/template`, `POST …/import/preview`, `POST …/import` |
| Group tasks | `GET /api/group-tasks/:id`, `POST …/status`, `POST …/responsible`, `POST …/comments`, `GET …/history` |
| Supervision | `GET /api/projects/:id/matrix`, `GET /api/blocked-tasks`, `GET /api/projects/:id/students/:userId/contributions` |

## Repository structure

```text
├── src/
│   ├── app.js, server.js
│   ├── config/         environment loading and validation
│   ├── auth/           OpenID Connect flow
│   ├── routes/         route tables
│   ├── controllers/    HTTP request/response handling
│   ├── services/       business rules and authorization
│   ├── repositories/   SQL
│   ├── middleware/     session user, CSRF, errors
│   ├── validators/     input validation
│   ├── utils/          errors, Markdown, colors
│   └── db/             pool, migration runner, create-admin
├── public/             frontend (HTML, CSS, JS modules)
├── migrations/         SQL migrations
├── tests/              automated tests
├── docs/architecture.md
├── examples/tasks-example.md
├── proxmox/            deployment scripts for kanban.ieti.site
├── docker-compose.yml  local MySQL
└── .env.example
```
