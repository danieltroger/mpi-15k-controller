#!/usr/bin/env bash
# Install (or update) the systemd unit that runs the MPI 15k controller.
#
# Usage, from a checkout of this repo on the target machine:
#   ./deploy/install-systemd-service.sh            # install/update + enable at boot
#   ./deploy/install-systemd-service.sh --print    # show the generated unit, change nothing
#
# Overridable via env (defaults fit the current pi):
#   SERVICE_USER=ubuntu   user the controller runs as (needs passwordless sudo for
#                         `sudo dtoverlay`, and dialout access to the inverter serial port)
#   REPO_DIR=<auto>       repo root; defaults to the checkout this script lives in
#   LOG_FILE=/var/log/mpi-15k-controller.log
#
# What you get: auto-respawn on crash (Restart=always, 30s backoff, no give-up limit),
# OOM-kill protection, start at boot ordered after network-online. The controller was
# previously launched from /etc/rc.local with no respawn — if migrating an old box,
# remove/comment that line, or the two instances will fight over the inverter's USB port.
#
# Also installs deploy/99-w1-therm-bulk-read.rules, the udev rule that lets the controller
# trigger one temperature conversion for the whole 1-wire bus (see deploy/README.md).
set -euo pipefail

SERVICE_NAME=mpi-15k-controller
SERVICE_USER=${SERVICE_USER:-ubuntu}
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
LOG_FILE=${LOG_FILE:-/var/log/${SERVICE_NAME}.log}
YARN_BIN=${YARN_BIN:-$(command -v yarn || echo /usr/bin/yarn)}
UNIT_PATH=/etc/systemd/system/${SERVICE_NAME}.service
UDEV_RULE_NAME=99-w1-therm-bulk-read.rules
UDEV_RULE_PATH=/etc/udev/rules.d/${UDEV_RULE_NAME}

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

# No user units are needed any more: the backend speaks PI17 over the serial port itself, so the
# retired mpp-solar user unit (which the old controller drove via `systemctl --user`, hence the
# lingering this script used to enable) must stay disabled — two writers on one serial port
# interleave garbage.

# 1-wire bulk read (#58): the rule makes therm_bulk_read writable for group ubuntu. Without it the
# controller still works, on per-probe reads (~11 s per sweep instead of ~1 s), and warns once per outage.
if [[ " $(id -nG "${SERVICE_USER}") " != *" ubuntu "* ]]; then
  echo "WARNING: ${SERVICE_USER} is not in group ubuntu, the group deploy/${UDEV_RULE_NAME} gives" >&2
  echo "write access to therm_bulk_read. Change the group in the rule, or the controller stays on" >&2
  echo "slow per-probe 1-wire reads." >&2
fi
if cmp -s "${REPO_DIR}/deploy/${UDEV_RULE_NAME}" "${UDEV_RULE_PATH}"; then
  echo "${UDEV_RULE_PATH} already up to date."
else
  sudo install -m 0644 "${REPO_DIR}/deploy/${UDEV_RULE_NAME}" "${UDEV_RULE_PATH}"
  echo "Wrote ${UDEV_RULE_PATH}"
  sudo udevadm control --reload-rules
  # Applies the rule to the probes attached right now. It only re-sends their uevents; the bus is untouched.
  sudo udevadm trigger --subsystem-match=w1 --action=change
  sudo udevadm settle
fi
ls -l /sys/bus/w1/devices/w1_bus_master1/therm_bulk_read 2>/dev/null ||
  echo "(no 1-wire probes attached yet: the rule applies when they attach)"

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

if [[ "${unit_changed}" == 1 && "${was_active}" == 1 ]]; then
  echo "NOTE: unit file changed while the service was already running."
  echo "Apply it with:  sudo systemctl restart ${SERVICE_NAME}"
  echo "(check backend/config.json scheduled_power_selling/buying for active windows first!)"
fi

systemctl status "${SERVICE_NAME}" --no-pager -n 0 || true
