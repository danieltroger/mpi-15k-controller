import { promises as fs } from "fs";
import { exec } from "../utilities/exec.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { describeDurationMs } from "../battery/historyRetryPolicy.ts";
import { wait } from "../vendor/depictUtilishared.ts";

export const ONE_WIRE_DEVICES_DIRECTORY = "/sys/bus/w1/devices";
/** The bus search attached all 14 probes within ~2 s of the overlay loading (boot of 2026-10-23); a dead probe mustn't hold the rest back for long. */
const PROBE_ATTACH_WAIT_LIMIT_MS = 30_000;
const PROBE_ATTACH_POLL_INTERVAL_MS = 500;

/**
 * Loads the w1-gpio overlay unless the bus master already exists (loading it twice on the same pin fails).
 * Judged by the master, not by listed probes: a master can be up with no probe listed yet (before its first
 * search) or any more (every probe timed out of the bus), and that's an empty bus, not a missing overlay.
 * Then waits (bounded) until the configured probes are listed, so the first sweep neither trips over a
 * half-done enumeration nor races udev to the permissions of therm_bulk_read, which appears with the first
 * probe (deploy/99-w1-therm-bulk-read.rules). Never rejects: a failure is logged here, and the sweeps then
 * report what they can't read.
 */
export async function enableOneWireBus(configuredProbeIds: string[]) {
  const busMasterListed = (await listOneWireDevices()).some(entry => entry.startsWith("w1_bus_master"));
  if (!busMasterListed) {
    try {
      const { stderr, stdout } = await exec("sudo dtoverlay w1-gpio gpiopin=4 pullup=0");
      if (stdout || stderr) logLog("Enabling thermometers returned", { stdout, stderr });
    } catch (error) {
      errorLog(
        "Couldn't load the 1-wire overlay (sudo dtoverlay w1-gpio), the thermometers will likely stay silent",
        error
      );
      return;
    }
  }
  await waitForProbesToAttach(configuredProbeIds);
}

async function waitForProbesToAttach(configuredProbeIds: string[]) {
  const waitStartedAtMs = Date.now();
  let missingProbeIds = configuredProbeIds;
  let listings = 0;
  while (Date.now() - waitStartedAtMs < PROBE_ATTACH_WAIT_LIMIT_MS) {
    const listedDevices = new Set(await listOneWireDevices());
    listings++;
    missingProbeIds = configuredProbeIds.filter(probeId => !listedDevices.has(probeId));
    if (!missingProbeIds.length) {
      if (listings > 1) {
        logLog(
          `All ${configuredProbeIds.length} configured thermometers on the 1-wire bus after ${describeDurationMs(Date.now() - waitStartedAtMs)}`
        );
      }
      return;
    }
    await wait(PROBE_ATTACH_POLL_INTERVAL_MS);
  }
  logLog(
    `Starting thermometer sweeps although ${missingProbeIds.join(", ")} still wasn't on the 1-wire bus after ${describeDurationMs(PROBE_ATTACH_WAIT_LIMIT_MS)}`
  );
}

/** Entries of /sys/bus/w1/devices: bus masters (w1_bus_master1) and probes (28-…) */
async function listOneWireDevices(): Promise<string[]> {
  try {
    return await fs.readdir(ONE_WIRE_DEVICES_DIRECTORY);
  } catch (error) {
    // The directory only exists once the w1 core is loaded, so ENOENT is the normal answer before the overlay
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnLog("Couldn't list the 1-wire devices in", ONE_WIRE_DEVICES_DIRECTORY, error);
    }
    return [];
  }
}
