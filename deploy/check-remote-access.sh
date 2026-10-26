#!/usr/bin/env bash
# Checks the pi's remote access (#57), from the pi: the units, autossh/sshx processes running outside
# them (e.g. left over from /etc/rc.local), and every tunnel end to end from the tunnel host's side.
# Read-only, apart from short probe connections through the tunnels. Exits 1 if anything is off.
#
# Usage, from a checkout of this repo on the pi:  ./deploy/check-remote-access.sh
set -euo pipefail

readonly CONFIG_DIR=/etc/remote-access
readonly TUNNELS=(ssh ws mqtt)

main() {
  local problems=0
  local units=(sshx.service)
  local tunnel
  for tunnel in "${TUNNELS[@]}"; do
    units+=("reverse-tunnel@${tunnel}.service")
  done

  echo "== Units"
  local unit
  for unit in "${units[@]}"; do
    if systemctl is-active --quiet "${unit}"; then
      echo "ok    ${unit} active"
    else
      echo "FAIL  ${unit} $(systemctl is-active "${unit}")"
      problems=1
    fi
  done

  echo "== Processes outside the units"
  if ! check_processes_are_supervised; then
    problems=1
  fi

  echo "== Tunnels, probed from the tunnel host"
  if ! probe_tunnels_from_remote; then
    problems=1
  fi

  echo "== Last sshx session published"
  # Exits 1 when nothing matches, e.g. once the journal has rotated past the last publish.
  if ! journalctl -u sshx.service --no-pager -o short-iso -g 'Published the new sshx session' -n 1; then
    echo "(none in the journal)"
  fi

  return "${problems}"
}

check_processes_are_supervised() {
  local unsupervised_found=0
  local line
  while read -r line; do
    if [[ ${line} != *" reverse-tunnel@"* && ${line} != *" sshx.service "* ]]; then
      echo "FAIL  ${line}"
      unsupervised_found=1
    fi
  done < <(ps -eo pid=,unit=,args= | grep -E '^ *[0-9]+ +[^ ]+ +((/usr/lib/autossh/autossh|(/usr/local/bin/)?sshx)( |$)|/usr/bin/ssh .*-R [0-9])')
  if ((unsupervised_found == 0)); then
    echo "ok    every autossh, tunnel ssh and sshx runs in reverse-tunnel@* or sshx.service"
  fi
  return "${unsupervised_found}"
}

# One ssh login to the tunnel host runs a probe per tunnel against its remote port there, so each probe
# goes through the tunnel: ssh must answer with its banner, the controller's ws server with an HTTP
# status line, mosquitto with a CONNACK.
probe_tunnels_from_remote() {
  local remote_login remote_port
  remote_login=$(read_env_setting "${CONFIG_DIR}/remote.env" TUNNEL_REMOTE_LOGIN)
  remote_port=$(read_env_setting "${CONFIG_DIR}/remote.env" TUNNEL_REMOTE_PORT)
  local probe_arguments=()
  local tunnel forward
  for tunnel in "${TUNNELS[@]}"; do
    forward=$(read_env_setting "${CONFIG_DIR}/tunnel-${tunnel}.env" TUNNEL_FORWARD)
    probe_arguments+=("${tunnel}" "${forward%%:*}")
  done
  ssh -o BatchMode=yes -o ConnectTimeout=15 -p "${remote_port}" "${remote_login}" \
    bash -s -- "${probe_arguments[@]}" <<'REMOTE_PROBES'
failed=0
while (($# >= 2)); do
  tunnel=$1 port=$2
  shift 2
  case ${tunnel} in
    ssh) reply=$(timeout 5 head -c 7 2>&1 </dev/tcp/127.0.0.1/"${port}") ;;
    ws) reply=$(timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1 && printf "GET / HTTP/1.0\r\n\r\n" >&3 && head -n 1 <&3' probe "${port}" 2>&1) ;;
    # MQTT 3.1.1 CONNECT, client id "remote-access-check"; any CONNACK (20 02) proves the broker answered.
    mqtt) reply=$(timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$1 && printf "\x10\x1f\x00\x04MQTT\x04\x02\x00\x3c\x00\x13remote-access-check" >&3 && head -c 2 <&3 | od -An -tx1' probe "${port}" 2>&1) ;;
    *) reply="(no probe for this tunnel)" ;;
  esac
  case ${tunnel}:${reply} in
    ssh:SSH-2.0* | ws:HTTP/* | mqtt:*"20 02"*) echo "ok    ${tunnel}: remote port ${port} answers: ${reply//$'\r'/}" ;;
    *)
      echo "FAIL  ${tunnel}: remote port ${port} gave: ${reply:-nothing}"
      failed=1
      ;;
  esac
done
exit "${failed}"
REMOTE_PROBES
}

# A value as the units see it: systemd's EnvironmentFile= drops one pair of quotes around it.
read_env_setting() {
  local file=$1 setting=$2 value
  value=$(sudo sed -n "s/^${setting}=//p" "${file}")
  if [[ ${value} =~ ^\"(.*)\"$ || ${value} =~ ^\'(.*)\'$ ]]; then
    value=${BASH_REMATCH[1]}
  fi
  printf '%s' "${value}"
}

main "$@"
