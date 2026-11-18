#!/bin/bash
# Deploys the committed main branch to the kanban.ieti.site container.
#
#   ./proxmoxDeploy.sh [user] [rsa_path] [server_port]
#
# The server keeps its own .env: it is never part of the package and never
# overwritten. Before the new code is started the
# MySQL database is dumped, so a failed release can be rolled back.
#
# DEPLOY_DRY_RUN=1 builds and verifies the package without contacting the server.
set -euo pipefail

ORIGINAL_DIR=$(pwd)
DEPLOY_AGENT_STARTED=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cleanup() {
  if [[ "$DEPLOY_AGENT_STARTED" == "1" ]]; then ssh-agent -k >/dev/null 2>&1 || true; fi
  cd "$ORIGINAL_DIR" 2>/dev/null || true
}
trap cleanup EXIT

source "$SCRIPT_DIR/config.env"

DEPLOY_USER=${1:-${DEFAULT_USER:-}}
RSA_PATH=${2:-"${DEFAULT_RSA_PATH:-}"}
SERVER_PORT=${3:-${DEFAULT_SERVER_PORT:-3000}}
RSA_PATH="${RSA_PATH%$'\r'}"

HOST="${DEFAULT_HOST:-}"
PORT_SSH="${DEFAULT_SSH_PORT:-}"
ZIP_NAME="server-package.zip"

cd "$PROJECT_DIR"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: el deploy només es permet des de la branca main (branca actual: ${CURRENT_BRANCH:-detached HEAD})."
  exit 1
fi

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk 'NR == 1 { print $1 }')"
if [[ -z "$REMOTE_MAIN" || "$LOCAL_HEAD" != "$REMOTE_MAIN" ]]; then
  echo "Error: main local no coincideix amb origin/main. Fes push o restaura main abans de desplegar."
  echo "Local:  $LOCAL_HEAD"
  echo "Remot:  ${REMOTE_MAIN:-no disponible}"
  exit 1
fi

rm -f "$ZIP_NAME"

# Archive only committed files. Local edits, secrets and runtime data stay local.
git archive --format=zip --output="$PROJECT_DIR/$ZIP_NAME" "$LOCAL_HEAD" -- . \
  ':(exclude)proxmox' \
  ':(exclude)tests' \
  ':(exclude)backups' \
  ':(exclude).claude' \
  ':(exclude).gitignore'

if unzip -Z1 "$ZIP_NAME" | grep -E \
  '(^|/)\.env$|(^|/)\.env\.[^/]*$|(^|/)node_modules(/|$)|(^|/)\.git(/|$)' \
  | grep -v -E '(^|/)\.env\.example$' >/dev/null; then
  echo "Error: el paquet conté configuració o dades de runtime; deploy cancel·lat."
  rm -f "$ZIP_NAME"
  exit 1
fi

echo "Desplegant main $LOCAL_HEAD (el .env del servidor es conservarà)."

if [[ "${DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  echo "✔️  Paquet verificat en mode dry-run; no s'ha contactat ni modificat el servidor."
  rm -f "$ZIP_NAME"
  exit 0
fi

if [[ -z "$HOST" || -z "$PORT_SSH" || -z "$DEPLOY_USER" ]]; then
  echo "Error: configura DEFAULT_HOST, DEFAULT_SSH_PORT i DEFAULT_USER a proxmox/config.env abans de desplegar."
  rm -f "$ZIP_NAME"
  exit 1
fi

if [[ ! -f "$RSA_PATH" ]]; then
  echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
  rm -f "$ZIP_NAME"
  exit 1
fi

eval "$(ssh-agent -s)" >/dev/null
DEPLOY_AGENT_STARTED=1
ssh-add "$RSA_PATH" >/dev/null

scp -P "$PORT_SSH" "$ZIP_NAME" "$DEPLOY_USER@$HOST:~/server-package.zip"
rm -f "$ZIP_NAME"

ssh -T -p "$PORT_SSH" -o UpdateHostKeys=no \
  "$DEPLOY_USER@$HOST" \
  bash -s -- "$SERVER_PORT" "$LOCAL_HEAD" << 'EOF'
set -euo pipefail

SERVER_PORT="$1"
RELEASE_SHA="$2"
APP_NAME="educational-kanban"
APP_DIR="$HOME/nodejs_server"
PKG="$HOME/server-package.zip"
TMP_DIR="$(mktemp -d)"
BACKUP_DIR="$(mktemp -d)"
REMOTE_USER="$(id -un)"
APP_STOPPED=0
RUNTIME_BACKUP_DIR=""

# Update only release-owned entries. The server's .env is never touched; obsolete files inside release directories are removed.
sync_release() {
  local source_dir="$1" entry name
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    case "$name" in .env) continue ;; esac
    if [[ -d "$entry" && ! -L "$entry" ]]; then
      [[ ! -L "$APP_DIR/$name" ]] || return 1
      mkdir -p "$APP_DIR/$name"
      rsync -a --delete "$entry/" "$APP_DIR/$name/" || return
    else
      rsync -a "$entry" "$APP_DIR/" || return
    fi
  done < <(find "$source_dir" -mindepth 1 -maxdepth 1 -print0)
}

cleanup_remote() {
  status=$?
  if [[ "$status" -ne 0 && "$APP_STOPPED" -eq 1 && -f "$BACKUP_DIR/package.json" ]]; then
    echo "⚠️  El deploy ha fallat; restaurant el codi anterior sense tocar el .env."
    pm2 delete app >/dev/null 2>&1 || true
    sync_release "$BACKUP_DIR" || true
    cd "$APP_DIR"
    pm2 start src/server.js --name app --update-env >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    if [[ -n "$RUNTIME_BACKUP_DIR" ]]; then
      echo "⚠️  Si una migració ha modificat la base de dades, restaura-la amb:"
      echo "    gunzip -c $RUNTIME_BACKUP_DIR/database.sql.gz | mysql -u <usuari> -p <base_de_dades>"
    fi
  fi
  rm -rf "$TMP_DIR" "$BACKUP_DIR"
  if [[ -n "$RUNTIME_BACKUP_DIR" ]]; then echo "Còpia de seguretat conservada: $RUNTIME_BACKUP_DIR"; fi
  exit "$status"
}
trap cleanup_remote EXIT

export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"

mkdir -p "$APP_DIR"

# Never overwrite a different application that may live in this account.
if [[ -f "$APP_DIR/package.json" ]]; then
  CURRENT_NAME="$(node -p "require('$APP_DIR/package.json').name" 2>/dev/null || true)"
  if [[ "$CURRENT_NAME" != "$APP_NAME" ]]; then
    echo "Error: $APP_DIR conté una altra aplicació (${CURRENT_NAME:-desconeguda}); deploy cancel·lat."
    exit 1
  fi
fi

# The server owns its configuration. It must exist before the first deploy.
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Error: falta $APP_DIR/.env."
  echo "Crea'l a partir de .env.example (NODE_ENV=production) i envia'l amb:"
  echo "  ./proxmoxSendFile.sh <fitxer_env>   i després, al servidor:   mv ~/<fitxer_env> $APP_DIR/.env && chmod 600 $APP_DIR/.env"
  exit 1
fi
chmod 600 "$APP_DIR/.env"

# Prepare and validate the new release before stopping the running app.
test -f "$PKG"
unzip -q -o "$PKG" -d "$TMP_DIR"
rm -f "$PKG"
PROJECT_DIR="$TMP_DIR"
test -f "$PROJECT_DIR/package.json"

cd "$PROJECT_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
test -f src/server.js
find src -type f -name '*.js' -print0 | xargs -0 -n1 node --check

# Read the database settings from the server's .env without loading app code.
read_env() {
  node -e "const v = require('node:util').parseEnv(require('node:fs').readFileSync('$APP_DIR/.env', 'utf8'))[process.argv[1]]; process.stdout.write(v || '')" "$1"
}
DB_HOST="$(read_env DB_HOST)"; DB_PORT="$(read_env DB_PORT)"; DB_NAME="$(read_env DB_NAME)"
DB_USER="$(read_env DB_USER)"; DB_PASSWORD="$(read_env DB_PASSWORD)"
if [[ "$(read_env NODE_ENV)" != "production" ]]; then
  echo "Error: el .env del servidor ha de tenir NODE_ENV=production; deploy cancel·lat."
  exit 1
fi
if [[ "$(read_env DEV_AUTH_ENABLED)" == "true" ]]; then
  echo "Error: DEV_AUTH_ENABLED=true no és permès al servidor; deploy cancel·lat."
  exit 1
fi
if [[ -z "$DB_NAME" || -z "$DB_USER" ]]; then
  echo "Error: falten DB_NAME o DB_USER al .env del servidor."
  exit 1
fi

# Keep a rollback copy of the current code. Runtime data stays in place.
if [[ -f "$APP_DIR/package.json" ]]; then
  rsync -a --delete --exclude '.env' "$APP_DIR/" "$BACKUP_DIR/"
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete app >/dev/null 2>&1 || true
fi
APP_STOPPED=1

for i in {1..10}; do
  PORT_LISTENERS="$(ss -H -ltn "sport = :$SERVER_PORT")"
  [[ -n "$PORT_LISTENERS" ]] && sleep 1 || break
done
PORT_LISTENERS="$(ss -H -ltn "sport = :$SERVER_PORT")"
if [[ -n "$PORT_LISTENERS" ]]; then
  echo "Error: el port $SERVER_PORT continua ocupat; deploy cancel·lat abans de tocar les dades."
  exit 1
fi

# Dump the database with the application stopped, before any migration runs.
# The backup lives outside the deployment target.
mkdir -p "$HOME/kanban-deploy-backups"
chmod 700 "$HOME/kanban-deploy-backups"
RUNTIME_BACKUP_DIR="$(mktemp -d "$HOME/kanban-deploy-backups/$(date -u +%Y%m%dT%H%M%SZ)-${RELEASE_SHA:0:8}-XXXXXX")"
MYSQL_PWD="$DB_PASSWORD" mysqldump --single-transaction --no-tablespaces --routines \
  -h "${DB_HOST:-localhost}" -P "${DB_PORT:-3306}" -u "$DB_USER" "$DB_NAME" \
  | gzip > "$RUNTIME_BACKUP_DIR/database.sql.gz"
gzip -t "$RUNTIME_BACKUP_DIR/database.sql.gz"
cp -p "$APP_DIR/.env" "$RUNTIME_BACKUP_DIR/.env"
echo "Còpia de la base de dades verificada: $RUNTIME_BACKUP_DIR/database.sql.gz"

sync_release "$PROJECT_DIR"

cd "$APP_DIR"
test -f package.json

# Apply pending database migrations with the server's own configuration.
node src/db/migrate.js

# Start app with PM2
pm2 start src/server.js --name app --update-env

HEALTHY=0
for i in {1..20}; do
  if curl -fsS "http://127.0.0.1:$SERVER_PORT/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "Error: la nova versió no ha superat el health check; restaurant l'anterior."
  pm2 logs app --lines 40 --nostream || true
  exit 1
fi

pm2 save
APP_STOPPED=0

# Configure PM2 to restart the app after a machine reboot
if command -v systemctl >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    sudo env PATH="$PATH" pm2 startup systemd -u "$REMOTE_USER" --hp "$HOME"
    pm2 save
    echo "✔️  PM2 configurat per iniciar-se automàticament després d'un reinici."
  else
    echo "⚠️  Deploy correcte, però no s'ha pogut configurar l'arrencada automàtica."
    echo "⚠️  Cal executar manualment al servidor:"
    echo "sudo env PATH=$PATH pm2 startup systemd -u $REMOTE_USER --hp $HOME"
    echo "pm2 save"
  fi
else
  echo "⚠️  No s'ha trobat systemd. No s'ha configurat l'arrencada automàtica amb PM2."
fi

echo "✔️  Deploy correcte. Estat PM2:"
pm2 status
EOF
