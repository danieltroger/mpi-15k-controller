#!/usr/bin/env bash
# Main process of sshx.service: runs one sshx session and exits once it is no longer usable, so that
# systemd starts a fresh one (installed to /usr/local/lib/remote-access/ by install-remote-access.sh).
#
#   - POSTs the session link to SSHX_PUBLISH_URL, as the old rc.local launcher did, so the current link
#     can be looked up remotely. Every sshx start is a new session with a new link.
#   - Forwards sshx's log to the journal without colour codes. Never logs the link's secret part.
#   - Gives up on a session the server has dropped. sshx 0.2.2 never does: once the server closes a
#     session (e.g. after its client was disconnected for a while), sshx retries it every 16 s forever,
#     logging "session is closed" and later "session not found", and the published link stays dead.
#     After the 2026-10-23 boot that started 6 minutes in and went on for days.
#
# Env: SSHX_PUBLISH_URL (required, from /etc/remote-access/remote.env); SSHX_BIN (default
# /usr/local/bin/sshx).
set -euo pipefail
shopt -s extglob

readonly SSHX_BIN=${SSHX_BIN:-/usr/local/bin/sshx}
# sshx prints its link within seconds. One without a link after this long is stuck.
readonly SESSION_URL_TIMEOUT_SECONDS=120
# A closed session never comes back, so one such error would do. Waiting for a few (sshx retries every
# 2-16 s) keeps a single odd reply from throwing away a working session and its link.
readonly DEAD_SESSION_ERRORS_BEFORE_RESTART=3

sshx_pid=
sshx_output_fd=
session_url=

main() {
  if [[ -z ${SSHX_PUBLISH_URL:-} ]]; then
    echo "SSHX_PUBLISH_URL is not set. It belongs in /etc/remote-access/remote.env." >&2
    exit 1
  fi
  if [[ ! -x ${SSHX_BIN} ]]; then
    echo "${SSHX_BIN} is missing or not executable." >&2
    exit 1
  fi
  start_sshx
  wait_for_session_url
  publish_session_url
  watch_session_log
}

start_sshx() {
  # stdout (just the link, with --quiet) and stderr (the log) share one pipe. The link is told apart
  # by its shape, since log lines start with a timestamp. sshx and the terminals it starts inherit its
  # environment and need none of remote.env's settings; only this script uses them.
  coproc SSHX_PROCESS {
    unset SSHX_PUBLISH_URL TUNNEL_REMOTE_LOGIN TUNNEL_REMOTE_PORT
    exec "${SSHX_BIN}" --quiet </dev/null 2>&1
  }
  sshx_pid=${SSHX_PROCESS_PID}
  # bash unsets the coproc's fd array as soon as sshx exits. Keep a copy to read its last lines.
  exec {sshx_output_fd}<&"${SSHX_PROCESS[0]}"
}

wait_for_session_url() {
  local line read_status remaining
  local deadline=$((SECONDS + SESSION_URL_TIMEOUT_SECONDS))
  # `remaining` is computed once per round: if SECONDS ticked between a loop test and the read, the read
  # would run as `read -t 0`, which returns 1 on an empty pipe and would pass for end of output.
  while remaining=$((deadline - SECONDS)) && ((remaining > 0)); do
    if IFS= read -r -t "${remaining}" line <&"${sshx_output_fd}"; then
      line=$(strip_colour_codes "${line}")
      if [[ ${line} =~ ^https://[^[:space:]]+$ ]]; then
        session_url=${line}
        return
      fi
      printf '%s\n' "${line}"
    else
      read_status=$?
      # Above 128 means the timeout ran out. Anything else is end of output, i.e. sshx exited.
      if ((read_status > 128)); then
        break
      fi
      exit_after_sshx_exited "before printing a session link"
    fi
  done
  echo "sshx printed no session link within ${SESSION_URL_TIMEOUT_SECONDS} s. Stopping it so systemd starts a new one." >&2
  stop_sshx_and_exit
}

publish_session_url() {
  # Same request the rc.local launcher sent (`curl -d "$line"`): a form POST whose body is the bare link.
  # The link goes in on stdin, not on curl's command line; curl reads it once and resends it on every
  # retry. curl's own errors name the host at most, never the publish URL's path.
  if printf '%s' "${session_url}" | curl --fail --silent --show-error --max-time 30 --retry 5 --retry-delay 10 \
    --retry-all-errors --output /dev/null --data-binary @- "${SSHX_PUBLISH_URL}"; then
    # Everything after '#' is the session's encryption key: whoever has it gets a shell.
    echo "Published the new sshx session ${session_url%%#*}#<key withheld>"
  else
    echo "Could not publish the sshx session link (curl exit status $?). A session nobody can find is useless: stopping sshx so systemd starts a new one." >&2
    stop_sshx_and_exit
  fi
}

watch_session_log() {
  local line
  local dead_session_errors=0
  while IFS= read -r line <&"${sshx_output_fd}"; do
    line=$(strip_colour_codes "${line}")
    printf '%s\n' "${line}"
    if [[ ${line} == *"session is closed"* || ${line} == *"session not found"* ]]; then
      dead_session_errors=$((dead_session_errors + 1))
      if ((dead_session_errors >= DEAD_SESSION_ERRORS_BEFORE_RESTART)); then
        echo "The sshx server has dropped this session (${dead_session_errors} errors saying so) and sshx would retry it forever. Stopping it so systemd starts a new one." >&2
        stop_sshx_and_exit
      fi
    fi
  done
  exit_after_sshx_exited "during the session"
}

strip_colour_codes() {
  local text=$1
  printf '%s' "${text//$'\e['*([0-9;])m/}"
}

stop_sshx_and_exit() {
  # SIGTERM ends sshx at once. systemd stops whatever else is left in the unit (the terminals' shells)
  # when this script exits, and Restart=always starts a fresh session after RestartSec.
  if kill -0 "${sshx_pid}" 2>/dev/null; then
    kill "${sshx_pid}"
  else
    echo "(sshx had exited already)" >&2
  fi
  exit 1
}

exit_after_sshx_exited() {
  local when=$1
  local sshx_status=0
  wait "${sshx_pid}" || sshx_status=$?
  echo "sshx exited ${when} with status ${sshx_status}. systemd starts a new session." >&2
  exit 1
}

main "$@"
