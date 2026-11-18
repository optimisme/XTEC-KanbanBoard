#!/bin/bash
# Prepares the kanban.ieti.site Proxmox container for this Node.js project:
# Node.js LTS, pm2, MySQL, and the application's database and MySQL user.
#
#   ./proxmoxInstall.sh [user] [rsa_path] [db_name] [db_user]
#
# The MySQL password is asked for interactively (or read from
# KANBAN_DB_PASSWORD) so that it never ends up in the shell history.

set -euo pipefail

cleanup() {
  ssh-agent -k >/dev/null 2>&1 || true
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.env"
: "${DEFAULT_HOST:?Configura DEFAULT_HOST a proxmox/config.env}"
: "${DEFAULT_SSH_PORT:?Configura DEFAULT_SSH_PORT a proxmox/config.env}"
: "${DEFAULT_USER:?Configura DEFAULT_USER a proxmox/config.env}"

USER=${1:-$DEFAULT_USER}
RSA_PATH=${2:-"$DEFAULT_RSA_PATH"}
MYSQL_DATABASE=${3:-kanban}
MYSQL_USER=${4:-kanban}
RSA_PATH="${RSA_PATH%$'\r'}"

HOST="$DEFAULT_HOST"
PORT_SSH="$DEFAULT_SSH_PORT"
SSH_OPTS='-oHostKeyAlgorithms=+ssh-rsa -oPubkeyAcceptedAlgorithms=+ssh-rsa'

MYSQL_PASSWORD="${KANBAN_DB_PASSWORD:-}"
if [[ -z "$MYSQL_PASSWORD" ]]; then
  read -r -s -p "Password for the MySQL user '$MYSQL_USER' (use the same value as DB_PASSWORD in the server .env): " MYSQL_PASSWORD
  echo
fi
if [[ ${#MYSQL_PASSWORD} -lt 12 ]]; then
  echo "Error: the MySQL password must be at least 12 characters long."
  exit 1
fi

echo "Target: $USER@$HOST:$PORT_SSH (kanban.ieti.site)"
echo "This installation can take 40 minutes or longer."
echo "Wait until the script prints the final completion message and returns to your local shell."
read -r -p "Continue with the remote installation? [y/N] " CONFIRM
case "$CONFIRM" in
  [yY]|[yY][eE][sS]) ;;
  *)
    echo "Installation cancelled."
    exit 0
    ;;
esac

if [[ ! -f "$RSA_PATH" ]]; then
  echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
  exit 1
fi

eval "$(ssh-agent -s)" >/dev/null
ssh-add "$RSA_PATH" >/dev/null

# The password travels on stdin (first line), not on the remote command line.
{
  printf '%s\n' "$MYSQL_PASSWORD"
  cat <<'EOF'
set -euo pipefail

MYSQL_DATABASE="$1"
MYSQL_USER="$2"

export DEBIAN_FRONTEND=noninteractive

echo "==> Fixing apt/dpkg state if needed"
dpkg --configure -a || true
apt-get -f install -y || true
apt-get clean || true
apt-get update

echo "==> Removing Apache if installed"
systemctl stop apache2 >/dev/null 2>&1 || true
apt-get purge -y apache2 apache2-bin apache2-data apache2-utils || true
apt-get autoremove --purge -y || true
rm -rf /etc/apache2 /var/www /var/log/apache2 /var/lib/apache2

echo "==> Installing system packages"
apt-get update
apt-get install -y npm zip unzip rsync curl iproute2 iptables-persistent mysql-server

echo "==> Installing Node.js LTS with n"
npm cache clean -f
npm install -g n
n lts
hash -r || true

echo "==> Installing pm2 globally"
npm install -g pm2

echo "==> Enabling MySQL"
systemctl enable mysql >/dev/null 2>&1 || true
systemctl start mysql

if [[ ! "$MYSQL_USER" =~ ^[A-Za-z0-9_]+$ || ! "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Error: MySQL user and database can only contain letters, numbers, and underscores."
  exit 1
fi

MYSQL_PASSWORD_SQL=${MYSQL_PASSWORD//\\/\\\\}
MYSQL_PASSWORD_SQL=${MYSQL_PASSWORD_SQL//\'/\'\'}

echo "==> Creating database '${MYSQL_DATABASE}' and user '${MYSQL_USER}'@'localhost'"
mysql --batch --skip-column-names <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED WITH caching_sha2_password BY '${MYSQL_PASSWORD_SQL}';
ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED WITH caching_sha2_password BY '${MYSQL_PASSWORD_SQL}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Installed versions"
node --version
npm --version
pm2 --version
mysql --version

echo "✔ Remote Proxmox install completed."
echo "Next: create the server .env (NODE_ENV=production, DB_NAME=${MYSQL_DATABASE}, DB_USER=${MYSQL_USER}), then run proxmoxDeploy.sh."
EOF
} | ssh -T -p "$PORT_SSH" $SSH_OPTS "$USER@$HOST" \
  "sudo -n bash -c 'IFS= read -r MYSQL_PASSWORD; export MYSQL_PASSWORD; exec bash -s -- \"\$1\" \"\$2\"' _ '$MYSQL_DATABASE' '$MYSQL_USER'"
