/**
 * Runs the real buying-setter graph (via buyingSetterWiringHarness.ts) against #48's real pure
 * scheduler (schedulerCore.ts) and a modelled inverter, in simulated time: setters are queued,
 * gated, sent, confirmed after the quiet gap and polled exactly as the session would, and their
 * readbacks flow back into the graph. Only the wire is faked.
 */
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { DecodedFields, SettingsQueryCommandName } from "../inverterComms/pi17Protocol.types.ts";
import {
  afterConfirmRun,
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  initialSchedulerState,
  type SchedulerState,
  type SchedulerTiming,
  withSettingsReadback,
  withSetterDequeued,
  withSetterQueued,
} from "../inverterComms/schedulerCore.ts";
import {
  advanceTo,
  createWiringHarness,
  decodeBats,
  decodeHecs,
  hallSample,
  type SimulatedClock,
  type WiringHarness,
} from "./buyingSetterWiringHarness.ts";

/** The live config's usb_parameter_setting.poll_values_interval_seconds */
const SETTINGS_POLL_INTERVAL_MS = 180_000;
/** Write → ACK at 2400 baud; the quiet gap counts from the ACK */
const SETTER_EXCHANGE_MS = 300;
const QUERY_EXCHANGE_MS = 500;
const POLL_ROUND_MS = 1_100;
const SETTINGS_POLL_ROUND_MS = 2_500;
/** Measured: a setter applies on the inverter's housekeeping cycle ~6 s after the write */
const COMMIT_AFTER_WRITE_MS = 6_000;
const STEP_MS = 250;

export type InverterModel = {
  limitAmps: number;
  acChargingEnabled: boolean;
  /** Setters the inverter ACKs but never applies */
  neverApplies: ReadonlySet<string>;
  pendingCommits: { atMs: number; command: string }[];
};

export type SentSetter = { atMs: number; command: string; limitAmpsAtSend: number; hallAmpsAtSend: number };

export type SessionSimulation = {
  clock: SimulatedClock;
  harness: WiringHarness;
  session: { scheduler: SchedulerState; itemsByCommand: Map<string, SetterQueueItem> };
  inverter: InverterModel;
  sent: SentSetter[];
  busyUntilMs: number;
  /** Time spent in quiet gaps and confirm backoffs, i.e. with GS/PS polling paused */
  pollingPausedMs: number;
};

export function createSessionSimulation({
  chargingAmperageForBuying,
  inverter,
  timingOverrides = {},
}: {
  chargingAmperageForBuying: number;
  inverter: Omit<InverterModel, "pendingCommits">;
  timingOverrides?: Partial<SchedulerTiming>;
}): SessionSimulation {
  const clock: SimulatedClock = { monotonicMs: -600_000 };
  // The session already holds trustworthy readbacks of the current state, like after a while of running
  let scheduler = initialSchedulerState(timingOverrides);
  scheduler = withSettingsReadback(scheduler, "BATS", batsFields(inverter.limitAmps), clock.monotonicMs);
  scheduler = withSettingsReadback(scheduler, "HECS", hecsFields(inverter.acChargingEnabled), clock.monotonicMs);
  const session: SessionSimulation["session"] = { scheduler, itemsByCommand: new Map() };
  const harness = createWiringHarness(
    {
      chargingAmperageForBuying,
      acChargeBatteryState: inverter.acChargingEnabled ? "enabled" : "disabled",
      hallBatteryAmps: modelledHallAmps({ ...inverter, pendingCommits: [] }),
    },
    {
      clock,
      queueSetter: item => queueIntoSession(session, clock, item),
      lastSentAtMsByCommand: () => session.scheduler.lastSentAtByCommand,
      settingsReadbackAtMs: query => session.scheduler.latestSettingsReadbacks[query]?.decodedAtMs,
    }
  );
  decodeHecs(harness, inverter.acChargingEnabled ? "enabled" : "disabled");
  decodeBats(harness, inverter.limitAmps);
  return {
    clock,
    harness,
    session,
    inverter: { ...inverter, pendingCommits: [] },
    sent: [],
    busyUntilMs: clock.monotonicMs,
    pollingPausedMs: 0,
  };
}

/** Steps simulated time in 250 ms steps: inverter commits, a fresh hall sample, then the scheduler */
export function runUntil(simulation: SessionSimulation, untilMs: number): void {
  for (let atMs = simulation.clock.monotonicMs + STEP_MS; atMs <= untilMs; atMs += STEP_MS) {
    advanceTo(simulation.harness, atMs);
    applyDueCommits(simulation.inverter, atMs);
    hallSample(simulation.harness, modelledHallAmps(simulation.inverter));
    runSchedulerStep(simulation, atMs);
  }
}

export function sentCommands(simulation: SessionSimulation, command: string, fromMs = -Infinity): SentSetter[] {
  return simulation.sent.filter(sent => sent.command === command && sent.atMs >= fromMs);
}

function queueIntoSession(session: SessionSimulation["session"], clock: SimulatedClock, item: SetterQueueItem): void {
  for (const pendingCommand of session.itemsByCommand.keys()) {
    if (pendingCommand.startsWith(item.replacesPrefix)) session.itemsByCommand.delete(pendingCommand);
  }
  session.itemsByCommand.set(item.command, item);
  session.scheduler = withSetterQueued(session.scheduler, item.command, item.replacesPrefix, clock.monotonicMs);
}

function runSchedulerStep(simulation: SessionSimulation, nowMs: number): void {
  const { session } = simulation;
  while (nowMs >= simulation.busyUntilMs) {
    const decision = decideNextAction(session.scheduler, nowMs, SETTINGS_POLL_INTERVAL_MS);
    if (decision.action === "drop_setter") {
      session.itemsByCommand.delete(decision.command);
      session.scheduler = withSetterDequeued(session.scheduler, decision.command);
      continue;
    }
    if (decision.action === "send_setter") {
      sendSetter(simulation, decision.command, nowMs);
    } else if (decision.action === "run_confirms") {
      const decodedByQuery = readSettings(simulation, decision.queries, nowMs);
      session.scheduler = afterConfirmRun(session.scheduler, decodedByQuery, nowMs).state;
      simulation.busyUntilMs = nowMs + QUERY_EXCHANGE_MS * decision.queries.length;
    } else if (decision.action === "poll_round") {
      const roundMs = decision.includeSettingsPoll ? SETTINGS_POLL_ROUND_MS : POLL_ROUND_MS;
      if (decision.includeSettingsPoll) readSettings(simulation, ["HECS", "BATS"], nowMs);
      session.scheduler = afterPollRound(session.scheduler, {
        startedAtMs: nowMs,
        endedAtMs: nowMs + roundMs,
        includedSettingsPoll: decision.includeSettingsPoll,
        hadFailures: false,
      });
      simulation.busyUntilMs = nowMs + roundMs;
    } else if (decision.reason !== "poll pacing") {
      simulation.pollingPausedMs += STEP_MS;
    }
    return;
  }
}

function sendSetter(simulation: SessionSimulation, command: string, nowMs: number): void {
  const { session, inverter } = simulation;
  const item = session.itemsByCommand.get(command);
  session.itemsByCommand.delete(command);
  session.scheduler = withSetterDequeued(session.scheduler, command);
  simulation.sent.push({
    atMs: nowMs,
    command,
    limitAmpsAtSend: inverter.limitAmps,
    hallAmpsAtSend: modelledHallAmps(inverter),
  });
  if (!inverter.neverApplies.has(command)) {
    inverter.pendingCommits.push({ atMs: nowMs + COMMIT_AFTER_WRITE_MS, command });
  }
  const ackedAtMs = nowMs + SETTER_EXCHANGE_MS;
  session.scheduler = afterSetterSent(session.scheduler, command, item?.refreshAfterSend ?? [], ackedAtMs, true);
  simulation.busyUntilMs = ackedAtMs;
}

/** Answers the settings queries from the model, recording them the way the session does before consumers see them */
function readSettings(
  simulation: SessionSimulation,
  queries: readonly SettingsQueryCommandName[],
  nowMs: number
): Partial<Record<SettingsQueryCommandName, DecodedFields>> {
  const decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>> = {};
  for (const query of queries) {
    if (query === "BATS") {
      decodedByQuery.BATS = batsFields(simulation.inverter.limitAmps);
      simulation.session.scheduler = withSettingsReadback(
        simulation.session.scheduler,
        "BATS",
        decodedByQuery.BATS,
        nowMs
      );
      decodeBats(simulation.harness, simulation.inverter.limitAmps);
    } else if (query === "HECS") {
      decodedByQuery.HECS = hecsFields(simulation.inverter.acChargingEnabled);
      simulation.session.scheduler = withSettingsReadback(
        simulation.session.scheduler,
        "HECS",
        decodedByQuery.HECS,
        nowMs
      );
      decodeHecs(simulation.harness, simulation.inverter.acChargingEnabled ? "enabled" : "disabled");
    }
  }
  return decodedByQuery;
}

function applyDueCommits(inverter: InverterModel, nowMs: number): void {
  const due = inverter.pendingCommits.filter(commit => commit.atMs <= nowMs);
  inverter.pendingCommits = inverter.pendingCommits.filter(commit => commit.atMs > nowMs);
  for (const { command } of due) {
    const limit = command.match(/^MUCHGC(\d{4})$/);
    if (limit) inverter.limitAmps = Number(limit[1]) / 10;
    if (command === "EDB1") inverter.acChargingEnabled = true;
    if (command === "EDB0") inverter.acChargingEnabled = false;
  }
}

/** Night, no PV: AC charging at its limit (the pack takes at most ~280 A), else the inverter's own draw */
function modelledHallAmps(inverter: InverterModel): number {
  return inverter.acChargingEnabled ? Math.min(inverter.limitAmps, 280) : -3;
}

function batsFields(limitAmps: number): DecodedFields {
  return { "max._ac_charging_current": limitAmps };
}

function hecsFields(acChargingEnabled: boolean): DecodedFields {
  return { ac_charge_battery: acChargingEnabled ? "enabled" : "disabled" };
}
