#!/usr/bin/env bash
# Install (or update) the pi's remote access as systemd units (#57): the autossh reverse tunnels
# (reverse-tunnel@ssh, @ws, @mqtt) and sshx (sshx.service). They used to be started by /etc/rc.local,
# where nothing restarted a tunnel that died.
#
# Usage, from a checkout of this repo on the pi:
#   ./deploy/install-remote-access.sh            # install/update the files + daemon-reload; starts nothing
#   ./deploy/install-remote-access.sh --enable   # the same, then enable + start all of them (fresh box)
#
# Needs /etc/remote-access/remote.env first (host-local: tunnel login + port, sshx publish URL), see
# deploy/remote-access/remote.env.example. Without --enable nothing is started or restarted, so
# migrating from rc.local can go one tunnel at a time (deploy/README.md has the steps). The units run
# as user ubuntu with its ssh key, like the rc.local lines did.
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPO_DIR
readonly SOURCE_DIR=${REPO_DIR}/deploy/remote-access
readonly CONFIG_DIR=/etc/remote-access
readonly REMOTE_ENV=${CONFIG_DIR}/remote.env
readonly SCRIPT_DIR=/usr/local/lib/remote-access
readonly UNIT_DIR=/etc/systemd/system
readonly TUNNELS=(ssh ws mqtt)
readonly SERVICE_USER=ubuntu
readonly SSH_KEY=/home/ubuntu/.ssh/id_ed25519

# Set by install_file when it wrote anything.
files_changed=0

main() {
  local enable=0
  case "${1:-}" in
    "") ;;
    --enable) enable=1 ;;
    *)
      echo "Usage: $0 [--enable]" >&2
      exit 2
      ;;
  esac

  check_prerequisites

  sudo install -d -m 0755 "${CONFIG_DIR}" "${SCRIPT_DIR}"
  install_file "${SOURCE_DIR}/reverse-tunnel@.service" "${UNIT_DIR}/reverse-tunnel@.service" 0644
  install_file "${SOURCE_DIR}/sshx.service" "${UNIT_DIR}/sshx.service" 0644
  install_file "${SOURCE_DIR}/sshx-session.sh" "${SCRIPT_DIR}/sshx-session.sh" 0755
  local tunnel
  for tunnel in "${TUNNELS[@]}"; do
    install_file "${SOURCE_DIR}/tunnel-${tunnel}.env" "${CONFIG_DIR}/tunnel-${tunnel}.env" 0644
  done
  sudo systemctl daemon-reload

  local units=()
  for tunnel in "${TUNNELS[@]}"; do
    units+=("reverse-tunnel@${tunnel}.service")
  done
  units+=(sshx.service)

  if ((enable)); then
    warn_about_rc_local_processes
    sudo systemctl enable --now "${units[@]}"
  else
    echo "Nothing started. Per unit: sudo systemctl enable --now <unit>; all of them: re-run with --enable."
  fi
  if ((files_changed)) && systemctl is-active --quiet "${units[@]}"; then
    echo "NOTE: units that were already running keep their old settings until restarted:"
    echo "  sudo systemctl restart <unit>"
    echo "(do reverse-tunnel@ssh from the LAN; sshx gets a new session link)"
  fi
  systemctl list-units --all --no-pager "${units[@]}"
}

check_prerequisites() {
  local missing=0
  local binary
  for binary in /usr/bin/autossh /usr/local/bin/sshx /usr/bin/curl; do
    if [[ ! -x ${binary} ]]; then
      echo "ERROR: ${binary} is missing." >&2
      missing=1
    fi
  done
  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    echo "ERROR: user ${SERVICE_USER} does not exist." >&2
    missing=1
  fi
  if ! sudo test -f "${SSH_KEY}"; then
    echo "ERROR: ${SSH_KEY} is missing. The tunnels log in to the remote with it." >&2
    missing=1
  fi
  if ! sudo test -f "${REMOTE_ENV}"; then
    echo "ERROR: ${REMOTE_ENV} is missing. Create it (root, mode 0600) from" >&2
    echo "deploy/remote-access/remote.env.example with this host's real values:" >&2
    echo "  sudo install -d -m 0755 ${CONFIG_DIR}" >&2
    echo "  sudo install -m 0600 ${SOURCE_DIR}/remote.env.example ${REMOTE_ENV}" >&2
    echo "  sudoedit ${REMOTE_ENV}" >&2
    missing=1
  else
    local setting
    for setting in TUNNEL_REMOTE_LOGIN TUNNEL_REMOTE_PORT SSHX_PUBLISH_URL; do
      if ! sudo grep -qE "^${setting}=.+" "${REMOTE_ENV}"; then
        echo "ERROR: ${REMOTE_ENV} sets no ${setting}." >&2
        missing=1
      fi
    done
    if sudo grep -qE '\.example\b|<id>' "${REMOTE_ENV}"; then
      echo "ERROR: ${REMOTE_ENV} still has the example's placeholder values." >&2
      missing=1
    fi
  fi
  if ((missing)); then
    exit 1
  fi
}

install_file() {
  local source=$1 destination=$2 mode=$3
  if sudo cmp -s "${source}" "${destination}"; then
    echo "${destination} already up to date."
  else
    sudo install -m "${mode}" "${source}" "${destination}"
    echo "Wrote ${destination}"
    files_changed=1
  fi
}

# Tunnels still running from /etc/rc.local hold the remote ports, so the new units keep retrying
# until those are gone. Harmless, but the tunnels aren't the new ones until then.
warn_about_rc_local_processes() {
  local pid cgroup
  for pid in $(pgrep -x autossh || true) $(pgrep -x sshx || true); do
    cgroup=$(cat "/proc/${pid}/cgroup" 2>/dev/null || true)
    # An empty cgroup means the process exited since pgrep listed it.
    if [[ -n ${cgroup} && ${cgroup} != *"/reverse-tunnel@"* && ${cgroup} != *"/sshx.service"* ]]; then
      echo "WARNING: $(ps -o args= -p "${pid}") (PID ${pid}) runs outside the new units, probably from" >&2
      echo "/etc/rc.local. Comment its line out there and stop it (deploy/README.md, migration)." >&2
    fi
  done
}

main "$@"
