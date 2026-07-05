#!/usr/bin/env bash
# Install (or update) the systemd unit that runs the MPI 15k controller.
#
# Usage, from a checkout of this repo on the target machine:
#   ./deploy/install-systemd-service.sh            # install/update + enable at boot
#   ./deploy/install-systemd-service.sh --print    # show the generated unit, change nothing
#
# Overridable via env (defaults fit the current pi):
#   SERVICE_USER=ubuntu   user the controller runs as (needs passwordless sudo for
#                         `sudo dtoverlay`, plus a systemd user instance for mpp-solar)
#   REPO_DIR=<auto>       repo root; defaults to the checkout this script lives in
#   LOG_FILE=/var/log/mpi-15k-controller.log
#
# What you get: auto-respawn on crash (Restart=always, 30s backoff, no give-up limit),
# OOM-kill protection, start at boot ordered after network-online. The controller was
# previously launched from /etc/rc.local with no respawn — if migrating an old box,
# remove/comment that line, or the two instances will fight over the inverter's USB port.
set -euo pipefail

SERVICE_NAME=mpi-15k-controller
SERVICE_USER=${SERVICE_USER:-ubuntu}
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
LOG_FILE=${LOG_FILE:-/var/log/${SERVICE_NAME}.log}
YARN_BIN=${YARN_BIN:-$(command -v yarn || echo /usr/bin/yarn)}
UNIT_PATH=/etc/systemd/system/${SERVICE_NAME}.service

generate_unit() {
  cat <<EOF
[Unit]
Description=MPI 15k inverter controller (solar/battery/auto-trading)
# Deliberately no network-online/time-sync ordering: battery management must
# start ASAP even when the router/NTP are down after a power cut, and the app
# retries all of its own connections. Do not add such dependencies here.
StartLimitIntervalSec=0

[Service]
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}/backend
ExecStart=${YARN_BIN} run-no-nodemon
Restart=always
RestartSec=30
OOMScoreAdjust=-800
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
EOF
}

if [[ "${1:-}" == "--print" ]]; then
  generate_unit
  exit 0
fi

[[ -d "${REPO_DIR}/backend" ]] || {
  echo "ERROR: no backend/ under REPO_DIR=${REPO_DIR}" >&2
  exit 1
}
[[ -x "${YARN_BIN}" ]] || {
  echo "ERROR: yarn not found (checked: ${YARN_BIN})" >&2
  exit 1
}
id -u "${SERVICE_USER}" >/dev/null 2>&1 || {
  echo "ERROR: user ${SERVICE_USER} does not exist" >&2
  exit 1
}

# Refuse to enable a second controller instance: anything matching the run command
# that is NOT inside our unit's cgroup (e.g. an rc.local launch) must be stopped first.
# An unreadable/missing cgroup file means the process is already gone — skip it.
for pid in $(pgrep -f "node --max-old-space-size.*src/index\.ts" || true); do
  cgroup=$(cat "/proc/${pid}/cgroup" 2>/dev/null || true)
  if [[ -n "${cgroup}" ]] && ! grep -q "${SERVICE_NAME}.service" <<<"${cgroup}"; then
    echo "ERROR: a controller instance is already running outside systemd (PID ${pid})." >&2
    echo "Stop it first (and remove its launch line from /etc/rc.local), then re-run." >&2
    exit 1
  fi
done

new_unit=$(generate_unit)
if [[ -f "${UNIT_PATH}" ]] && diff -q <(printf '%s\n' "${new_unit}") "${UNIT_PATH}" >/dev/null 2>&1; then
  echo "${UNIT_PATH} already up to date."
  unit_changed=0
else
  printf '%s\n' "${new_unit}" | sudo tee "${UNIT_PATH}" >/dev/null
  echo "Wrote ${UNIT_PATH}"
  unit_changed=1
fi

# Snapshot BEFORE enable --now: on a fresh install the service starts below with
# the just-written unit, so no restart hint is needed afterwards.
was_active=0
systemctl is-active --quiet "${SERVICE_NAME}" && was_active=1

# The controller drives the mpp-solar *user* unit via `systemctl --user`; lingering
# keeps the user instance (and mpp-solar) alive at boot without an SSH session.
sudo loginctl enable-linger "${SERVICE_USER}"

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

if [[ "${unit_changed}" == 1 && "${was_active}" == 1 ]]; then
  echo "NOTE: unit file changed while the service was already running."
  echo "Apply it with:  sudo systemctl restart ${SERVICE_NAME}"
  echo "(check backend/config.json scheduled_power_selling/buying for active windows first!)"
fi

systemctl status "${SERVICE_NAME}" --no-pager -n 0 || true
