#!/bin/bash
# Copies the production runtime state (a MySQL dump and .env) into
# backups/<UTC timestamp>/, which Git ignores. Read-only on the server: the
# app keeps running and the dump uses a single consistent transaction.
#
#   ./proxmoxBackup.sh [user] [rsa_path]
#
# BACKUP_DIR overrides the local destination folder.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_ROOT="${BACKUP_DIR:-$PROJECT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
PARTIAL="$DEST.partial"

# Server-side part: stages a consistent copy in a private temp folder and
# streams it as a tar archive on stdout. Messages go to stderr.
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -euo pipefail
APP_DIR="$1"
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
chmod 700 "$STAGE"
cd "$APP_DIR"
test -f .env || { echo "Error: no hi ha .env a $APP_DIR" >&2; exit 1; }

read_env() {
  node -e "const v = require('node:util').parseEnv(require('node:fs').readFileSync('.env', 'utf8'))[process.argv[1]]; process.stdout.write(v || '')" "$1"
}
DB_HOST="$(read_env DB_HOST)"; DB_PORT="$(read_env DB_PORT)"; DB_NAME="$(read_env DB_NAME)"
DB_USER="$(read_env DB_USER)"; DB_PASSWORD="$(read_env DB_PASSWORD)"

MYSQL_PWD="$DB_PASSWORD" mysqldump --single-transaction --no-tablespaces --routines \
  -h "${DB_HOST:-localhost}" -P "${DB_PORT:-3306}" -u "$DB_USER" "$DB_NAME" \
  | gzip > "$STAGE/database.sql.gz"
gzip -t "$STAGE/database.sql.gz"

cp -p .env "$STAGE/.env"

cd "$STAGE"
printf 'created_utc=%s\nhost=%s\napp_dir=%s\ndatabase=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$APP_DIR" "$DB_NAME" > BACKUP_INFO.txt
if command -v sha256sum >/dev/null 2>&1; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 $SUM > SHA256SUMS
echo "Snapshot OK: database $DB_NAME" >&2
tar -C "$STAGE" -czf - .
REMOTE
)

cleanup() { rm -rf "$PARTIAL"; }
trap cleanup EXIT

source "$SCRIPT_DIR/config.env"
BACKUP_USER=${1:-${DEFAULT_USER:-}}
RSA_PATH=${2:-"${DEFAULT_RSA_PATH:-}"}
RSA_PATH="${RSA_PATH%$'\r'}"
HOST="${DEFAULT_HOST:-}"
PORT_SSH="${DEFAULT_SSH_PORT:-}"
if [[ -z "$HOST" || -z "$PORT_SSH" || -z "$BACKUP_USER" ]]; then
  echo "Error: configura DEFAULT_HOST, DEFAULT_SSH_PORT i DEFAULT_USER a proxmox/config.env."
  exit 1
fi
if [[ ! -f "$RSA_PATH" ]]; then
  echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
  exit 1
fi

umask 077
mkdir -p "$BACKUP_ROOT" "$PARTIAL"
chmod 700 "$BACKUP_ROOT"

echo "Copiant dades i configuració de $BACKUP_USER@$HOST..."
ssh -T -i "$RSA_PATH" -p "$PORT_SSH" -o UpdateHostKeys=no "$BACKUP_USER@$HOST" \
  bash -s -- '$HOME/nodejs_server' <<<"$REMOTE_SCRIPT" | tar -xzf - -C "$PARTIAL"

# Verify locally what arrived before keeping it.
(cd "$PARTIAL" && shasum -a 256 -c --quiet SHA256SUMS)
gzip -t "$PARTIAL/database.sql.gz"

mv "$PARTIAL" "$DEST"
echo "✔️  Còpia verificada a $DEST"
du -sh "$DEST" | cut -f1 | sed 's/^/   Mida: /'
