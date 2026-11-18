#!/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.env"
: "${DEFAULT_HOST:?Configura DEFAULT_HOST a proxmox/config.env}"
: "${DEFAULT_SSH_PORT:?Configura DEFAULT_SSH_PORT a proxmox/config.env}"
: "${DEFAULT_USER:?Configura DEFAULT_USER a proxmox/config.env}"

USER=${1:-$DEFAULT_USER}

SSH_OPTS='-oHostKeyAlgorithms=+ssh-rsa -oPubkeyAcceptedAlgorithms=+ssh-rsa'
CTRL_DIR="${TMPDIR:-/tmp}"
CTRL_SOCK="$CTRL_DIR/kanban_mysql_tunnel_3308.sock"

if ssh -S "$CTRL_SOCK" -p "$DEFAULT_SSH_PORT" $SSH_OPTS -O check "$USER@$DEFAULT_HOST" >/dev/null 2>&1; then
  echo "Tunnel: ON (127.0.0.1:3308)"
  exit 0
fi

echo "Tunnel: OFF"
exit 1
