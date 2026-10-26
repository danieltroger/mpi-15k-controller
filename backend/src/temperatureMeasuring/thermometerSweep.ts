import path from "path";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import { describeDurationMs } from "../battery/historyRetryPolicy.ts";
import { describeFileError, type SysfsAccess } from "./sysfsAccess.ts";
import {
  checkPlausibility,
  parseTemperatureAttribute,
  parseW1SlaveText,
  type ProbeReadingCheck,
} from "./thermometerReadingParsing.ts";

export type ThermometerProbe = { thermometer_device_id: string; label: string };

export type ThermometerSweepTiming = {
  /** How long to poll therm_bulk_read for "done" after the trigger write has returned */
  conversionWaitLimitMs: number;
  statusPollIntervalMs: number;
  /** While the bulk path is down, how often a sweep tries it again before falling back */
  bulkRetryIntervalMs: number;
  /** Consecutive failed sweeps after which one probe's failure streak gets a warning */
  probeFailureWarnAfterSweeps: number;
};

export const DEFAULT_THERMOMETER_SWEEP_TIMING: ThermometerSweepTiming = {
  // On 5.15 the trigger write itself sleeps out the conversion (750 ms at 12 bit) and the status reads "done"
  // as soon as it returns. The limit is for a kernel that converts in the background: 12-bit time plus margin.
  conversionWaitLimitMs: 1000,
  statusPollIntervalMs: 50,
  bulkRetryIntervalMs: 60_000,
  // ~5 min at one sweep per 10 s
  probeFailureWarnAfterSweeps: 30,
};

export type ThermometerSweepState = {
  /** Set from the first failed bulk attempt until one succeeds again */
  bulkOutage: BulkReadOutage | undefined;
  /** Whether the log has said yet that bulk reads work */
  bulkAnnounced: boolean;
  lastAcceptedCelsius: Map<string, number>;
  /** Consecutive failed sweeps per probe (device id), absent while the probe reads fine */
  failureStreaks: Map<string, number>;
};

export type SweepLogger = { log: (...details: unknown[]) => void; warn: (...details: unknown[]) => void };

export type ThermometerSweepContext = {
  probes: ThermometerProbe[];
  state: ThermometerSweepState;
  sysfs: SysfsAccess;
  logger: SweepLogger;
  /** /sys/bus/w1/devices in production */
  devicesDirectory: string;
  timing: ThermometerSweepTiming;
};

export type ThermometerSweepResult = {
  method: ReadMethod;
  /** Only the probes that read fine: a failed probe keeps its previous reading wherever it's shown */
  readings: TemperatureReadingBroadcast[];
  durationMs: number;
};

type ReadMethod = "bulk" | "w1_slave";
type ProbeAttribute = "temperature" | "w1_slave";
type BulkReadOutage = { startedAtMs: number; failedAttempts: number; nextAttemptAtMs: number; lastReason: string };
type BulkConversionOutcome = { ok: true } | { ok: false; reason: string };

/** The bus master's bulk attribute, relative to the devices directory. All 14 probes are on master 1. */
const BULK_READ_ATTRIBUTE = path.join("w1_bus_master1", "therm_bulk_read");
/**
 * therm_bulk_read_store only acts on a write of exactly sizeof("trigger") = 8 bytes, and it reports success
 * for anything else too, so the newline is load-bearing (it's what `echo trigger >` sends).
 */
const BULK_TRIGGER_COMMAND = "trigger\n";

/**
 * One pass over the configured probes. Normally that is a single CONVERT T for the whole bus through the
 * master's therm_bulk_read, then each probe's `temperature` attribute, which after a bulk conversion only
 * reads the scratchpad: ~1 s for 14 probes, one thread-pool thread at a time. While the bulk path fails (no
 * write permission, missing attribute, a trigger the kernel ignored) it reads `w1_slave` instead, where every
 * read runs its own 750 ms conversion (~11 s for 14 probes), and tries the bulk path again every
 * bulkRetryIntervalMs. Sysfs failures never throw: they are logged here, and the probe is left out of `readings`.
 */
export async function sweepThermometers(context: ThermometerSweepContext): Promise<ThermometerSweepResult> {
  const sweepStartedAtMs = context.sysfs.nowMs();
  const bulkConversion = await convertAllProbesIfDue(context);
  const method: ReadMethod = bulkConversion.converted ? "bulk" : "w1_slave";
  const readings: TemperatureReadingBroadcast[] = [];
  // One probe at a time: the kernel serialises the bus anyway, and this holds one thread-pool thread, not 14
  for (const probe of context.probes) {
    const reading = await readProbe(context, probe, method);
    if (reading) readings.push(reading);
  }
  const durationMs = context.sysfs.nowMs() - sweepStartedAtMs;
  if (bulkConversion.announcement) {
    context.logger.log(
      `${bulkConversion.announcement}: read ${readings.length}/${context.probes.length} probes in ${durationMs} ms`
    );
  }
  return { method, readings, durationMs };
}

export function createThermometerSweepState(): ThermometerSweepState {
  return { bulkOutage: undefined, bulkAnnounced: false, lastAcceptedCelsius: new Map(), failureStreaks: new Map() };
}

/** Bulk-converts unless the bulk path is down and its retry isn't due; logs the outage's start, cause changes and end. */
async function convertAllProbesIfDue(
  context: ThermometerSweepContext
): Promise<{ converted: boolean; announcement?: string }> {
  const { state, sysfs, logger, timing } = context;
  const outage = state.bulkOutage;
  const attemptedAtMs = sysfs.nowMs();
  if (outage && attemptedAtMs < outage.nextAttemptAtMs) return { converted: false };

  const conversion = await triggerBulkConversion(context);
  if (conversion.ok) {
    state.bulkOutage = undefined;
    const firstAnnouncement = !state.bulkAnnounced;
    state.bulkAnnounced = true;
    if (outage) {
      return {
        converted: true,
        announcement: `1-wire bulk read works again after ${describeDurationMs(attemptedAtMs - outage.startedAtMs)} of per-probe reads (${outage.failedAttempts} failed attempts)`,
      };
    }
    return firstAnnouncement
      ? { converted: true, announcement: "1-wire bulk read active (one conversion for the whole bus per sweep)" }
      : { converted: true };
  }

  const nextAttemptAtMs = attemptedAtMs + timing.bulkRetryIntervalMs;
  if (!outage) {
    state.bulkOutage = {
      startedAtMs: attemptedAtMs,
      failedAttempts: 1,
      nextAttemptAtMs,
      lastReason: conversion.reason,
    };
    logger.warn(
      `1-wire bulk read unavailable: ${conversion.reason}. Falling back to per-probe w1_slave reads (a 750 ms conversion each, ~11 s per sweep) and trying the bulk trigger again every ${describeDurationMs(timing.bulkRetryIntervalMs)}. A permission error means deploy/99-w1-therm-bulk-read.rules isn't applied (see deploy/README.md).`
    );
    return { converted: false };
  }
  outage.failedAttempts++;
  outage.nextAttemptAtMs = nextAttemptAtMs;
  if (conversion.reason !== outage.lastReason) {
    // The outage itself was warned about when it began; a change of cause is still worth a line
    logger.log(`1-wire bulk read still unavailable, now: ${conversion.reason}`);
    outage.lastReason = conversion.reason;
  }
  return { converted: false };
}

async function triggerBulkConversion({
  sysfs,
  devicesDirectory,
  timing,
}: ThermometerSweepContext): Promise<BulkConversionOutcome> {
  const bulkReadPath = path.join(devicesDirectory, BULK_READ_ATTRIBUTE);
  try {
    await sysfs.writeText(bulkReadPath, BULK_TRIGGER_COMMAND);
  } catch (error) {
    return { ok: false, reason: `writing the trigger to ${bulkReadPath} failed (${describeFileError(error)})` };
  }
  const writeReturnedAtMs = sysfs.nowMs();
  while (true) {
    let statusText: string;
    try {
      statusText = await sysfs.readText(bulkReadPath);
    } catch (error) {
      return { ok: false, reason: `reading ${bulkReadPath} back failed (${describeFileError(error)})` };
    }
    // -1: a conversion is running. 1: converted, scratchpads not all read yet. 0: nothing pending at all.
    const status = statusText.trim();
    if (status === "1") return { ok: true };
    if (status === "0") {
      return { ok: false, reason: `the kernel ignored the trigger (${bulkReadPath} reads 0 right after it)` };
    }
    if (status !== "-1") {
      return { ok: false, reason: `${bulkReadPath} reads ${JSON.stringify(statusText)}, expected -1, 0 or 1` };
    }
    if (sysfs.nowMs() - writeReturnedAtMs >= timing.conversionWaitLimitMs) {
      return { ok: false, reason: `conversion still pending ${timing.conversionWaitLimitMs} ms after the trigger` };
    }
    await sysfs.sleep(timing.statusPollIntervalMs);
  }
}

async function readProbe(
  context: ThermometerSweepContext,
  probe: ThermometerProbe,
  method: ReadMethod
): Promise<TemperatureReadingBroadcast | undefined> {
  const attribute: ProbeAttribute = method === "bulk" ? "temperature" : "w1_slave";
  const check = await readAndCheckAttribute(context, probe.thermometer_device_id, attribute);
  if (!check.ok) {
    recordProbeFailure(context, probe, `${attribute}: ${check.reason}`);
    return undefined;
  }
  recordProbeSuccess(context, probe);
  context.state.lastAcceptedCelsius.set(probe.thermometer_device_id, check.celsius);
  return {
    value: check.celsius,
    time: context.sysfs.nowMs(),
    thermometer_device_id: probe.thermometer_device_id,
    label: probe.label,
  };
}

async function readAndCheckAttribute(
  { sysfs, devicesDirectory, state }: ThermometerSweepContext,
  thermometerDeviceId: string,
  attribute: ProbeAttribute
): Promise<ProbeReadingCheck> {
  let attributeText: string;
  try {
    attributeText = await sysfs.readText(path.join(devicesDirectory, thermometerDeviceId, attribute));
  } catch (error) {
    return { ok: false, reason: `read failed (${describeFileError(error)})` };
  }
  const parsed =
    attribute === "temperature" ? parseTemperatureAttribute(attributeText) : parseW1SlaveText(attributeText);
  if (!parsed.ok) return parsed;
  return checkPlausibility(parsed.celsius, state.lastAcceptedCelsius.get(thermometerDeviceId));
}

function recordProbeFailure(
  { state, logger, timing }: ThermometerSweepContext,
  probe: ThermometerProbe,
  reason: string
) {
  const failedSweeps = (state.failureStreaks.get(probe.thermometer_device_id) ?? 0) + 1;
  state.failureStreaks.set(probe.thermometer_device_id, failedSweeps);
  const probeName = `thermometer ${probe.thermometer_device_id} (${probe.label})`;
  logger.log(`Failed reading ${probeName}, ${failedSweeps} sweep(s) in a row: ${reason}`);
  if (failedSweeps === timing.probeFailureWarnAfterSweeps) {
    logger.warn(
      `No reading from ${probeName} for ${failedSweeps} sweeps in a row, its last value is going stale. Latest failure: ${reason}`
    );
  }
}

function recordProbeSuccess({ state, logger, timing }: ThermometerSweepContext, probe: ThermometerProbe) {
  const failedSweeps = state.failureStreaks.get(probe.thermometer_device_id) ?? 0;
  if (failedSweeps >= timing.probeFailureWarnAfterSweeps) {
    logger.log(
      `Thermometer ${probe.thermometer_device_id} (${probe.label}) reads again after ${failedSweeps} failed sweeps`
    );
  }
  state.failureStreaks.delete(probe.thermometer_device_id);
}
