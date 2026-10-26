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
 * Loads the w1-gpio overlay unless probes are on the bus already (loading it twice fails). After
 * loading it, waits until the configured probes have
 * attached, so the first sweep neither trips over a half-done enumeration nor races udev to the
 * permissions of therm_bulk_read, which appears with the first probe (deploy/99-w1-therm-bulk-read.rules).
 * Never rejects: a failure is logged here, and the sweeps then report what they can't read.
 */
export async function enableOneWireBus(configuredProbeIds: string[]) {
  if ((await listAttachedProbes()).length) return;
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
  await waitForProbesToAttach(configuredProbeIds);
}

async function waitForProbesToAttach(configuredProbeIds: string[]) {
  const waitStartedAtMs = Date.now();
  let missingProbeIds = configuredProbeIds;
  while (Date.now() - waitStartedAtMs < PROBE_ATTACH_WAIT_LIMIT_MS) {
    const attachedProbeIds = new Set(await listAttachedProbes());
    missingProbeIds = configuredProbeIds.filter(probeId => !attachedProbeIds.has(probeId));
    if (!missingProbeIds.length) {
      logLog(
        `All ${configuredProbeIds.length} configured thermometers attached ${describeDurationMs(Date.now() - waitStartedAtMs)} after loading the 1-wire overlay`
      );
      return;
    }
    await wait(PROBE_ATTACH_POLL_INTERVAL_MS);
  }
  logLog(
    `Starting thermometer sweeps although ${missingProbeIds.join(", ")} hadn't attached ${describeDurationMs(PROBE_ATTACH_WAIT_LIMIT_MS)} after loading the 1-wire overlay`
  );
}

/** Device ids of the DS18B20s (family 28) the kernel currently lists on the bus */
async function listAttachedProbes(): Promise<string[]> {
  try {
    return (await fs.readdir(ONE_WIRE_DEVICES_DIRECTORY)).filter(entry => entry.startsWith("28-"));
  } catch (error) {
    // The directory only exists once the w1 core is loaded, so ENOENT is the normal answer before the overlay
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnLog("Couldn't list the 1-wire devices in", ONE_WIRE_DEVICES_DIRECTORY, error);
    }
    return [];
  }
}
