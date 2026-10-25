/**
 * Turns a PERSISTENT plausibility-gate drop into an errorLog (→ the "Error logged" P2) — pure.
 *
 * The gate exists for one-off garbage (a misdecoded frame). A command whose every round fails it
 * for minutes is more likely reporting something real and alarming — a BMS trip reading < 40 V, a
 * grid fault reading a frequency the gate doesn't expect — and meanwhile every consumer of that
 * command's fields (undervoltage, grid-out, the stuck-inverter rules, SOC anchor detection, the
 * dashboard) is frozen on its last good values. So after PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS of
 * nothing but drops for one command, say so once, with the offending fields; an accepted round of
 * that command ends the episode.
 */
import type { Pi17QueryCommandName } from "./pi17Protocol.types.ts";

/** Long enough that a burst of line garbage never pages; short enough to beat the 2-min stale rules */
export const PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS = 90_000;

export type GateDropEpisode = {
  firstDropAtMs: number;
  droppedRounds: number;
  latestProblems: readonly string[];
  escalated: boolean;
};

export type GateDropEpisodes = Readonly<Partial<Record<Pi17QueryCommandName, GateDropEpisode>>>;

export function afterGateDrop(
  episodes: GateDropEpisodes,
  command: Pi17QueryCommandName,
  problems: readonly string[],
  nowMs: number
): { episodes: GateDropEpisodes; escalation: string | undefined } {
  const previous = episodes[command];
  const episode: GateDropEpisode = {
    firstDropAtMs: previous?.firstDropAtMs ?? nowMs,
    droppedRounds: (previous?.droppedRounds ?? 0) + 1,
    latestProblems: problems,
    escalated: previous?.escalated ?? false,
  };
  let escalation: string | undefined;
  const droppingForMs = nowMs - episode.firstDropAtMs;
  if (!episode.escalated && droppingForMs >= PERSISTENT_GATE_DROP_ERRORLOG_AFTER_MS) {
    episode.escalated = true;
    escalation =
      `Every ${command} round for ${Math.round(droppingForMs / 1000)} s (${episode.droppedRounds} in a row) ` +
      `failed the plausibility gate: ${problems.join("; ")} — all ${command} values are frozen at their last ` +
      `good reading. A persistent "impossible" value is likely real: check the inverter/BMS.`;
  }
  return { episodes: { ...episodes, [command]: episode }, escalation };
}

/** An accepted round of `command` ends its drop episode; returns the episode it ended, if any. */
export function afterGateAccept(
  episodes: GateDropEpisodes,
  command: Pi17QueryCommandName
): { episodes: GateDropEpisodes; endedEpisode: GateDropEpisode | undefined } {
  if (!episodes[command]) return { episodes, endedEpisode: undefined };
  const { [command]: episodeBeingEnded, ...remainingEpisodes } = episodes;
  return { episodes: remainingEpisodes, endedEpisode: episodeBeingEnded };
}
