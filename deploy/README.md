# Deployment

The controller runs as the systemd unit `mpi-15k-controller.service`: auto-respawn on crash (30 s backoff, retries forever), OOM-kill protection (`OOMScoreAdjust=-800`), starts at boot, and appends stdout/stderr to `/var/log/mpi-15k-controller.log` (same file as the old rc.local setup). It deliberately waits for **neither network-online nor NTP**: after a power cut the router may be down too, and battery management availability beats both clock precision and clean first connections — the app retries on its own.

## Install / update

```sh
./deploy/install-systemd-service.sh
```

Idempotent. Refuses to run if a controller instance is already running outside systemd (old rc.local-style launch) — stop that one and remove its line from `/etc/rc.local` first. `SERVICE_USER`, `REPO_DIR` and `LOG_FILE` can be overridden via env for a non-standard box; `--print` shows the generated unit without touching anything. It also installs the 1-wire udev rule described below.

Day-to-day:

```sh
systemctl status mpi-15k-controller
sudo systemctl restart mpi-15k-controller   # check config.json for active sell/buy windows first
tail -f /var/log/mpi-15k-controller.log
```

## 1-wire bulk read permission (udev rule)

The controller reads the 14 DS18B20 thermometers in one sweep every 10 s: it writes `trigger` to `/sys/bus/w1/devices/w1_bus_master1/therm_bulk_read`, which runs one conversion for the whole bus (the write blocks ~750 ms at 12-bit resolution), then reads each probe's `temperature` attribute, which then only reads the probe's scratchpad. A sweep takes ~1 s. The kernel creates `therm_bulk_read` as `root` 0644, so [`99-w1-therm-bulk-read.rules`](99-w1-therm-bulk-read.rules) makes it group-writable for group `ubuntu`. The rule matches each probe's `add` uevent, because the attribute appears together with the first probe and sends no uevent of its own. It therefore applies at boot, when the controller loads the overlay with `sudo dtoverlay`, and whenever the bus finds its probes again.

Without the rule (or after any other bulk failure) the controller falls back to per-probe `w1_slave` reads, a 750 ms conversion each, ~11 s per sweep. It logs one `[WARN] 1-wire bulk read unavailable: …` per outage, retries the bulk trigger every minute, and logs `1-wire bulk read works again …` when it recovers.

`install-systemd-service.sh` installs and applies the rule. By hand:

```sh
sudo install -m 0644 deploy/99-w1-therm-bulk-read.rules /etc/udev/rules.d/99-w1-therm-bulk-read.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=w1 --action=change   # or reboot
sudo udevadm settle
ls -l /sys/bus/w1/devices/w1_bus_master1/therm_bulk_read     # expect: -rw-rw-r-- 1 root ubuntu
```

`udevadm trigger` only re-sends the w1 devices' uevents; it doesn't touch the bus or start a conversion. After a controller (re)start, the log should show `1-wire bulk read active (one conversion for the whole bus per sweep): read 14/14 probes in … ms`, with a duration of about 1000 ms.

## Remote access: reverse tunnels and sshx

Off-site access to the pi runs as its own systemd units, separate from the controller (#57). It used to be started by `/etc/rc.local`, where nothing restarted a tunnel that died: it stayed down until the next reboot.

| Unit                  | What                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `reverse-tunnel@ssh`  | remote port 6022 → the pi's sshd (22)                                                       |
| `reverse-tunnel@ws`   | remote port 7777 → the controller's ws server (9321)                                        |
| `reverse-tunnel@mqtt` | remote port 1883 → mosquitto (1883)                                                         |
| `sshx`                | an [sshx](https://sshx.io) web terminal; each new session's link is POSTed to a publish URL |

All four run as `ubuntu` (the tunnels log in with `~/.ssh/id_ed25519`, as before), start at boot after `network-online.target` (unlike the controller, they can't do anything without the network) and restart forever.

- **Tunnels** ([`reverse-tunnel@.service`](remote-access/reverse-tunnel@.service), forwards in `remote-access/tunnel-*.env`): `autossh -M 0` with `ServerAliveInterval=30`/`ServerAliveCountMax=3`, so a dead link is noticed within ~90 s and autossh starts a new ssh. With `ExitOnForwardFailure=yes`, ssh exits when the remote port is still taken, and autossh retries, instead of the connection staying up without the forward. `AUTOSSH_GATETIME=0` keeps autossh retrying when the first connection after boot fails. `AUTOSSH_POLL=60` scales autossh's backoff between failed attempts down 10× and caps it at a minute; by default the gap grows to 10 minutes about an hour into an outage. systemd restarts autossh itself if it exits. Logs go to the journal.
- **sshx** ([`sshx.service`](remote-access/sshx.service) → [`sshx-session.sh`](remote-access/sshx-session.sh)): starts `sshx --quiet`, POSTs the session link to `SSHX_PUBLISH_URL` (the same request the rc.local line sent), and exits when the sshx server has dropped the session. systemd then starts a new session, with a new link, 30 s later. sshx itself retries a dropped session forever: after the 2026-10-23 boot the published link was dead within 6 minutes and stayed dead for days. The journal shows the session id but not the link's key. Terminals opened in sshx run inside the unit and end when it restarts.

### Host-local settings: `/etc/remote-access/remote.env`

The tunnels' remote login and ssh port, and the sshx publish URL, are host-specific and stay out of this public repo. The publish URL works like a password: anyone who has it can post a link there. They live in `/etc/remote-access/remote.env` (root, mode 0600; systemd reads it before dropping to `ubuntu`). On the pi they are the values the old rc.local lines used. Template: [`remote-access/remote.env.example`](remote-access/remote.env.example).

```sh
sudo install -d -m 0755 /etc/remote-access
sudo install -m 0600 deploy/remote-access/remote.env.example /etc/remote-access/remote.env
sudoedit /etc/remote-access/remote.env
```

### Install / update

```sh
./deploy/install-remote-access.sh            # install/update the files + daemon-reload; starts nothing
./deploy/install-remote-access.sh --enable   # the same, then enable + start all four (fresh box)
```

It copies the units to `/etc/systemd/system/`, the forwards to `/etc/remote-access/tunnel-*.env` and `sshx-session.sh` to `/usr/local/lib/remote-access/`. Copies, so remote access doesn't depend on what is checked out in the repo. Idempotent. It refuses to run without a complete `remote.env`. Units that are already running keep their old settings until `sudo systemctl restart <unit>`. Restart `reverse-tunnel@ssh` from the LAN, not through the tunnel; restarting `sshx` publishes a new link.

Day-to-day:

```sh
./deploy/check-remote-access.sh          # units, stray processes, and each tunnel probed end to end
journalctl -u 'reverse-tunnel@*' -f      # or -u reverse-tunnel@ssh for one
journalctl -u sshx -n 20                 # "Published the new sshx session https://sshx.io/s/…"
sudo systemctl restart reverse-tunnel@mqtt
```

[`check-remote-access.sh`](check-remote-access.sh) is read-only. It logs in to the tunnel host and connects to each tunnel's remote port there, so the probe goes through the tunnel: sshd must answer with its banner, the controller's ws server with an HTTP status line (`426 Upgrade Required`), mosquitto with a CONNACK. It also flags any autossh, tunnel ssh or sshx running outside the units, e.g. one left over from rc.local.

A refused forward ends the tunnel's ssh within seconds (`ExitOnForwardFailure`), and the journal says `Error: remote port forwarding failed for listen port …`. Expect that for a minute or two **after a power cut**: the tunnel host still holds the port for the session that died with the pi until its sshd gives up on it (`ClientAliveInterval 30`, `ClientAliveCountMax 3` there, so ~90 s). autossh keeps retrying and gets the port once it's free.

### Migrating from `/etc/rc.local`

Do it all from a machine on the LAN (`ssh ubuntu@192.168.1.106`). That path doesn't go through any tunnel, so a tunnel that doesn't come back can always be fixed from there. Steps 1–6 don't touch the controller; only the reboot test (7) restarts it.

**Backups:** step 1 makes `/etc/rc.local.bak-before-57` with `cp -n`, so re-running the step never overwrites it with an already-edited file. **Never restore an older rc.local backup.** `/etc/rc.local.bak-20260705` still starts the controller, and a second controller would fight the systemd one over the inverter's serial port. The rollbacks below only uncomment the lines this migration commented out.

**0. Get the files:** `cd ~/mpi-15k-controller && git pull`. If other controller changes come with the pull, they land on disk too and run from the next controller restart, i.e. the reboot test.

**1. Back up, configure, install.** Nothing starts yet.

```sh
cd ~/mpi-15k-controller
sudo cp -an /etc/rc.local /etc/rc.local.bak-before-57
grep -oE '[a-z]+@[^ ]+ -v?p [0-9]+' /etc/rc.local | sort -u    # → TUNNEL_REMOTE_LOGIN and TUNNEL_REMOTE_PORT
grep -oE 'https://[^"]+/deploy/sshx-[^"]+' /etc/rc.local      # → SSHX_PUBLISH_URL
sudo install -d -m 0755 /etc/remote-access
sudo install -m 0600 deploy/remote-access/remote.env.example /etc/remote-access/remote.env
sudoedit /etc/remote-access/remote.env
./deploy/install-remote-access.sh          # expect 6× "Wrote …", then "Nothing started"
```

**2.+3. Switch the tunnels one at a time, least critical first (mqtt, ws, ssh), and verify each.** A new tunnel can't bind its remote port while the rc.local one holds it. With `ExitOnForwardFailure` it would only retry until the port is free, so stop the old one first, then start the new one. Each tunnel is down for a few seconds. Each rc.local autossh is identified by its monitor port (`-M`): 2975 = mqtt, 2988 = ws, 2990 = ssh. Stopping an autossh also stops its ssh child.

```sh
# mqtt (old autossh -M 2975)
pkill -u ubuntu -f '^/usr/lib/autossh/autossh -M 2975 '
sleep 2; pgrep -af 'ssh -L 2975' || echo "old mqtt tunnel gone"   # still there: pkill -u ubuntu -f '^/usr/bin/ssh -L 2975:'
sudo systemctl enable --now reverse-tunnel@mqtt
sleep 20; journalctl -u reverse-tunnel@mqtt -n 10 --no-pager      # "ssh child pid is …", no "remote port forwarding failed"
./deploy/check-remote-access.sh   # "Tunnels" must be all ok. Units/processes not switched yet still show FAIL.

# ws: the same with -M 2988 / 'ssh -L 2988' / reverse-tunnel@ws
# ssh: the same with -M 2990 / 'ssh -L 2990' / reverse-tunnel@ssh
```

`check-remote-access.sh` probes through whichever tunnel holds each remote port, so its "Tunnels" section shows that remote access works at every point of the switch. If a new tunnel doesn't come up after a minute, check `journalctl -u reverse-tunnel@<name>`. To put the old one back: `sudo systemctl disable --now reverse-tunnel@<name>`, then `sudo bash -c "$(grep -F -- '-R <remote port>:' /etc/rc.local.bak-before-57)"`. Each of 6022, 7777 and 1883 matches exactly one line there.

**sshx:**

```sh
pkill -u ubuntu -x sshx                    # the rc.local session; its link has been dead since 2026-10-23
sudo systemctl enable --now sshx
journalctl -u sshx -n 5 --no-pager         # "Published the new sshx session https://sshx.io/s/…#<key withheld>"
```

Then open the new link from wherever it's normally looked up.

**4. Comment the migrated lines out of rc.local.** That's the up.txt loop, sshx, the three autossh lines and `timedatectl`. The prefix is fixed, so the rollback can find exactly these lines again. Lines that are already commented (the controller, the old smb tunnel) are left alone.

```sh
sudo sed -i -E "/^[^#]*(up\.txt|sshx|autossh|timedatectl)/s|^|# (replaced by reverse-tunnel@.service/sshx.service, $(date +%F)) |" /etc/rc.local
grep -c '^# (replaced by reverse-tunnel@' /etc/rc.local   # 6
grep -vE '^(#|$)' /etc/rc.local                            # only "cd /tmp" and "exit 0" left
bash -n /etc/rc.local
```

**5. Stop what rc.local still runs, and clean up after it.**

```sh
sudo systemctl kill rc-local.service       # only the up.txt loop is left in there
systemctl status rc-local --no-pager       # active (exited), no processes listed
sudo rm -f /tmp/sshx-setup.log /tmp/autossh-ssh.log /tmp/autossh-frontend-ws.log /tmp/autossh-mqtt.log /tmp/timezone.log /tmp/pid
sudo rm /var/log/up.txt                    # optional (136 MB)
```

**6. Verify:** `./deploy/check-remote-access.sh` prints `ok` for all four units, the processes and all three tunnels, and exits 0.

**7. Reboot test** (optional, but it's the case this is for):

- **Best done when someone can physically reach the pi.** A tunnel that doesn't come back can be fixed from the LAN, but a pi that doesn't boot can't.
- It restarts the controller. Pick a time with no sell/buy window active or imminent (`scheduled_power_selling/buying.schedule` in `backend/config.json`, UTC keys), not within ±10 min of `automatic_trading.plan_at_local_time`.
- Run `sudo reboot`, then wait for `ping 192.168.1.106` and `ssh ubuntu@192.168.1.106`.
- Run `./deploy/check-remote-access.sh` (all ok) and `systemctl status mpi-15k-controller rc-local --no-pager` (rc-local lists no processes).
- **Fallback:** fix whatever didn't come up (`journalctl -u <unit> -b`) over the LAN. To go back to the rc.local setup, run the commands below. They uncomment only the six migrated lines; the controller line stays commented.

```sh
sudo systemctl disable --now reverse-tunnel@ssh reverse-tunnel@ws reverse-tunnel@mqtt sshx
sudo sed -i 's|^# (replaced by reverse-tunnel@.service/sshx.service, [0-9-]*) ||' /etc/rc.local
grep -c 'replaced by mpi-15k-controller.service' /etc/rc.local   # still 1: the controller stays commented
sudo reboot
```

### What else rc.local did

- **Uptime logger** (`date` + `uptime` into `/var/log/up.txt` every minute): dropped rather than rotated. The file had reached 136 MB. It answered "when did the pi go down", which the persistent journal answers directly: `journalctl --list-boots` shows each boot's first and last entry. The controller log also has a line every few seconds. After the migration, `/var/log/up.txt` can be deleted.
- **Timezone reset** (`timedatectl set-timezone Europe/Stockholm` at every boot): dropped. The setting persists by itself (`/etc/localtime` → `Europe/Stockholm`). The symlink dates from 2026-04-12 and survived the reboots since, and timedated only rewrites it when the zone changes, so nothing has reset the zone at boot since then. cloud-init's user-data sets no timezone.

## What a fresh pi needs besides this (non-exhaustive pointers)

- Node ≥ 26 (nodesource deb) and a `yarn` binary on PATH; the repo is Yarn PnP zero-install, so no `yarn install` is required to run.
- `backend/config.json` — not in the repo (contains coordinates/credentials); copy from the old box.
- Nothing for the inverter link beyond the cable: the backend talks PI17 over the serial port itself (`backend/src/inverterComms/`). The old mpp-solar poller (python venv at `~/mpp-solar`, `mpp-solar` systemd **user** unit) is retired; it must stay **disabled** (`systemctl --user disable --now mpp-solar`), because two programs on one serial port interleave garbage.
- Device access for `SERVICE_USER`: inverter serial (FTDI cable at `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0` → inverter RS-232; the old `/dev/hidraw0` USB path rejects >16-byte commands and is unused since 2026-07), I2C (ADS1115 current sensor), 1-wire (temperature, needs `sudo dtoverlay` = passwordless sudo, plus the udev rule above), plus MQTT broker and InfluxDB reachable per config.
- Remote access (autossh tunnels, sshx): `/etc/remote-access/remote.env`, then `./deploy/install-remote-access.sh --enable` (see above). Needs `autossh`, `curl`, `/usr/local/bin/sshx` and `ubuntu`'s ssh key authorized on the tunnel host. `/etc/rc.local` isn't needed any more.
