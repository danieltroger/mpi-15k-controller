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

## What a fresh pi needs besides this (non-exhaustive pointers)

- Node ≥ 26 (nodesource deb) and a `yarn` binary on PATH; the repo is Yarn PnP zero-install, so no `yarn install` is required to run.
- `backend/config.json` — not in the repo (contains coordinates/credentials); copy from the old box.
- Nothing for the inverter link beyond the cable: the backend talks PI17 over the serial port itself (`backend/src/inverterComms/`). The old mpp-solar poller (python venv at `~/mpp-solar`, `mpp-solar` systemd **user** unit) is retired; it must stay **disabled** (`systemctl --user disable --now mpp-solar`), because two programs on one serial port interleave garbage.
- Device access for `SERVICE_USER`: inverter serial (FTDI cable at `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0` → inverter RS-232; the old `/dev/hidraw0` USB path rejects >16-byte commands and is unused since 2026-07), I2C (ADS1115 current sensor), 1-wire (temperature, needs `sudo dtoverlay` = passwordless sudo, plus the udev rule above), plus MQTT broker and InfluxDB reachable per config.
- The other rc.local inhabitants (sshx, autossh tunnels) are separate from the controller and still live in `/etc/rc.local`.
