# mpi-15k-controller — conventions & operational notes

This repo live-controls a 15 kW MPI hybrid inverter + 65 kWh LiFePO4 battery powering a house. The backend runs directly from TypeScript source on Node's native type stripping — imports need explicit `.ts` extensions and `import type` for type-only imports (no enums/namespaces/parameter properties; only erasable TS syntax).

## Code conventions

- **Never swallow errors silently.** Every `catch` either handles the error meaningfully or logs it via `errorLog`/`warnLog` with enough context to debug. If a failure "can't happen", that's exactly why it must be loud when it does. Expected cases (e.g. a state file's first-boot ENOENT) may be quiet, but only when explicitly distinguished from unexpected ones.
- **Main function at the top of the file.** Export the primary function first; helpers go below it (function declarations hoist) or into their own files. Split files that accumulate several unrelated responsibilities.
- **Config values keep their snake_case names end-to-end.** When passing chunks of config around, spread the config section (`{ ...config().automatic_trading, extra_field: ... }`) instead of hand-mapping snake_case to camelCase — no translation walls.
- Comments explain constraints the code can't express (hardware quirks, economics, protocol bugs), not what the next line does.
- Run `yarn prettier --write` on changed files before committing (CI auto-formats otherwise) and `yarn typecheck` from the repo root.

## Operational safety (the pi this runs on)

- The controller is a systemd unit: `sudo systemctl restart mpi-15k-controller`. Logs: `/var/log/mpi-15k-controller.log`.
- **Never start a second instance of `backend/src/index.ts`** — it would fight the live process over the inverter USB port and send real hardware commands. Test with `yarn typecheck`, the pure planner self-test (`backend/src/autoTrading/planner.selftest.ts`), and the read-only dry-run (`backend/src/autoTrading/planPreview.ts`).
- Before restarting, check no sell/buy window is active or imminent: `scheduled_power_selling/buying.schedule` in `backend/config.json` (UTC keys), and avoid ±10 min around the daily plan run (`automatic_trading.plan_at_local_time`, Europe/Stockholm).
- The process writes `backend/config.json` at runtime (debounced, with backup files) — don't hand-edit that file while the service runs; use the frontend/ws API instead.
- `backend/auto_trader_state.json` records which schedule entries the auto-trader owns. Deleting it makes existing planner windows look user-owned (they stop being managed) — harmless but confusing.
