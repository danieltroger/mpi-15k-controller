/**
 * The session's log side of the plausibility gate: each dropped round is counted and warned about
 * (rate-limited), and a persistent drop escalates once (gateDropEscalation.ts decides when).
 */
import { errorLog, logLog } from "../utilities/logging.ts";
import type { createRateLimitedWarnLog } from "../utilities/rateLimitedWarnLog.ts";
import { afterGateAccept, afterGateDrop, type GateDropEpisodes } from "./gateDropEscalation.ts";
import type { Pi17QueryCommandName } from "./pi17Protocol.types.ts";

/** The part of the session state the gate reporting owns */
export type GateDropReporting = {
  droppedImplausibleRounds: number;
  gateDropEpisodes: GateDropEpisodes;
  warnImplausibleRound: ReturnType<typeof createRateLimitedWarnLog>;
};

export function recordGateDrop(
  reporting: GateDropReporting,
  command: Pi17QueryCommandName,
  implausibleFields: string[]
): void {
  reporting.droppedImplausibleRounds++;
  reporting.warnImplausibleRound(
    "Dropping implausible",
    command,
    "round before any consumer sees it:",
    implausibleFields.join("; "),
    `(${reporting.droppedImplausibleRounds} dropped since start)`
  );
  const { episodes, escalation } = afterGateDrop(
    reporting.gateDropEpisodes,
    command,
    implausibleFields,
    performance.now()
  );
  reporting.gateDropEpisodes = episodes;
  if (escalation) errorLog("Inverter plausibility gate:", escalation);
}

export function recordGateAccept(reporting: GateDropReporting, command: Pi17QueryCommandName): void {
  const { episodes, endedEpisode } = afterGateAccept(reporting.gateDropEpisodes, command);
  reporting.gateDropEpisodes = episodes;
  if (endedEpisode?.escalated) {
    logLog("Inverter", command, "rounds pass the plausibility gate again after", endedEpisode.droppedRounds, "drops");
  }
}
