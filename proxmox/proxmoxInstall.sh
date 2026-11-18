#!/bin/bash
# Prepares the kanban.ieti.site container for this application: installs what
# is missing (MySQL, curl, unzip, rsync, Node.js, pm2) and creates the
# application's database and MySQL user.
#
#   ./proxmoxInstall.sh [user] [rsa_path]
#
# The database name, user and password are read on the server from the
# configuration file sent beforehand (~/kanban.env, or ~/nodejs_server/.env
# once deployed), so no password is typed or passed on a command line.
# The server asks for the sudo password in this terminal.
#
# Safe to run more than once: existing packages, databases and users are kept.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.env"
: "${DEFAULT_HOST:?Configura DEFAULT_HOST a proxmox/config.env}"
: "${DEFAULT_SSH_PORT:?Configura DEFAULT_SSH_PORT a proxmox/config.env}"
: "${DEFAULT_USER:?Configura DEFAULT_USER a proxmox/config.env}"

USER=${1:-$DEFAULT_USER}
RSA_PATH=${2:-"$DEFAULT_RSA_PATH"}
RSA_PATH="${RSA_PATH%$'\r'}"
HOST="$DEFAULT_HOST"
PORT_SSH="$DEFAULT_SSH_PORT"
SSH_OPTS='-oHostKeyAlgorithms=+ssh-rsa -oPubkeyAcceptedAlgorithms=+ssh-rsa -oUpdateHostKeys=no'

if [[ ! -f "$RSA_PATH" ]]; then
  echo "Error: No s'ha trobat la clau privada: $RSA_PATH"
  exit 1
fi

echo "Target: $USER@$HOST:$PORT_SSH (kanban.ieti.site)"
echo "Installs the missing packages (MySQL, curl, ...) and creates the application database."
read -r -p "Continue with the remote installation? [y/N] " CONFIRM
case "$CONFIRM" in
  [yY]|[yY][eE][sS]) ;;
  *)
    echo "Installation cancelled."
    exit 0
    ;;
esac

REMOTE_SCRIPT="$(mktemp)"
trap 'rm -f "$REMOTE_SCRIPT"' EXIT

cat > "$REMOTE_SCRIPT" <<'EOF'
#!/bin/bash
# Runs as root on the server. $1 is the home directory of the deploy user.
set -euo pipefail

USER_HOME="$1"
ENV_FILE=""
for candidate in "$USER_HOME/kanban.env" "$USER_HOME/nodejs_server/.env"; do
  if [[ -f "$candidate" ]] && grep -q '^DB_NAME=' "$candidate"; then ENV_FILE="$candidate"; break; fi
done
if [[ -z "$ENV_FILE" ]]; then
  echo "Error: no configuration file found. Send it first with: ./proxmoxSendFile.sh ../kanban.env"
  exit 1
fi

env_value() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
MYSQL_DATABASE="$(env_value DB_NAME)"
MYSQL_USER="$(env_value DB_USER)"
MYSQL_PASSWORD="$(env_value DB_PASSWORD)"

if [[ ! "$MYSQL_USER" =~ ^[A-Za-z0-9_]+$ || ! "$MYSQL_DATABASE" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "Error: DB_NAME and DB_USER can only contain letters, numbers and underscores."
  exit 1
fi
if [[ ${#MYSQL_PASSWORD} -lt 12 ]]; then
  echo "Error: DB_PASSWORD in $ENV_FILE must have at least 12 characters."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/bin:$PATH"

echo "==> Installing missing system packages"
apt-get update
apt-get install -y mysql-server curl zip unzip rsync iproute2

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js LTS"
  apt-get install -y npm
  npm install -g n
  n lts
  hash -r || true
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2"
  npm install -g pm2
fi

echo "==> Enabling MySQL"
systemctl enable mysql >/dev/null 2>&1 || true
systemctl start mysql

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
pm2 --version
mysql --version
curl --version | head -n 1

echo "✔ Server ready. Next: DEPLOY_REPLACE_EXISTING=1 ./proxmoxDeploy.sh (first deploy) or ./proxmoxDeploy.sh"
EOF

scp -i "$RSA_PATH" -P "$PORT_SSH" $SSH_OPTS "$REMOTE_SCRIPT" "$USER@$HOST:~/kanban-install.sh" >/dev/null

# -t gives sudo a terminal, so it can ask for the password here.
ssh -t -i "$RSA_PATH" -p "$PORT_SSH" $SSH_OPTS "$USER@$HOST" \
  'sudo bash "$HOME/kanban-install.sh" "$HOME"; status=$?; rm -f "$HOME/kanban-install.sh"; exit $status'
