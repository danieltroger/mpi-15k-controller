# Deployment

The controller runs as the systemd unit `mpi-15k-controller.service`: auto-respawn on crash (30 s backoff, retries forever), OOM-kill protection (`OOMScoreAdjust=-800`), starts at boot, and appends stdout/stderr to `/var/log/mpi-15k-controller.log` (same file as the old rc.local setup). It deliberately waits for **neither network-online nor NTP**: after a power cut the router may be down too, and battery management availability beats both clock precision and clean first connections — the app retries on its own.

## Install / update

```sh
./deploy/install-systemd-service.sh
```

Idempotent. Refuses to run if a controller instance is already running outside systemd (old rc.local-style launch) — stop that one and remove its line from `/etc/rc.local` first. `SERVICE_USER`, `REPO_DIR` and `LOG_FILE` can be overridden via env for a non-standard box; `--print` shows the generated unit without touching anything.

Day-to-day:

```sh
systemctl status mpi-15k-controller
sudo systemctl restart mpi-15k-controller   # check config.json for active sell/buy windows first
tail -f /var/log/mpi-15k-controller.log
```

## What a fresh pi needs besides this (non-exhaustive pointers)

- Node ≥ 26 (nodesource deb) and a `yarn` binary on PATH; the repo is Yarn PnP zero-install, so no `yarn install` is required to run.
- `backend/config.json` — not in the repo (contains coordinates/credentials); copy from the old box.
- The mpp-solar poller: python venv at `~/mpp-solar` with a `mpp-solar` systemd **user** unit (the controller stops/starts it around USB commands; the install script enables lingering so it survives without SSH sessions).
- Device access for `SERVICE_USER`: inverter USB (`/dev/hidraw0`), I2C (ADS1115 current sensor), 1-wire (temperature, needs `sudo dtoverlay` = passwordless sudo), plus MQTT broker and InfluxDB reachable per config.
- The other rc.local inhabitants (sshx, autossh tunnels) are separate from the controller and still live in `/etc/rc.local`.
