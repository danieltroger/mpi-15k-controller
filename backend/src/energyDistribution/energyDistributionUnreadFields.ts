/**
 * Managed HECS fields missing from the inverter's answers (an empty token), tracked apart from the divergence
 * episodes: pure, no clock. Such a field is never written (no SEP on a guess) while the fields that were read
 * are judged and enforced as usual. One that stays missing for p2_after_minutes pages once, with its own
 * onset and key, so it can neither hold a divergence episode open nor use up its P2: a real divergence that
 * starts later pages p2_after_minutes after its own onset (#92's review). The wiring is
 * useEnergyDistributionEnforcement.ts, the wording energyDistributionAlert.ts.
 */
import type { EnergyDistributionField } from "./energyDistribution.types.ts";

/** From the first judged readback that lacked a managed field until one has them all */
export type UnreadFieldsEpisode = {
  sinceMs: number;
  /** What the latest judged readback lacked */
  fields: readonly EnergyDistributionField[];
  p2Raised: boolean;
};

export type UnreadFieldsStep = {
  episode: UnreadFieldsEpisode | undefined;
  /** This step started the episode */
  started: boolean;
  /** The episode's P2 is due (once per episode) */
  raiseP2: boolean;
  /** The episode this step ended: a judged readback had every managed field */
  resolved: UnreadFieldsEpisode | undefined;
};

/**
 * `unreadFields` is the judged readback's (nextEnforcementStep's judged.unreadFields); undefined when nothing
 * was judged (no profile in force, a stale readback, a DM switch pending): an open episode then stays open
 * and still pages once overdue. The episode keeps its object while nothing changes, so the wiring's signal
 * (and the ws) only moves when it does.
 */
export function nextUnreadFieldsStep(
  episode: UnreadFieldsEpisode | undefined,
  unreadFields: readonly EnergyDistributionField[] | undefined,
  nowMs: number,
  p2AfterMs: number
): UnreadFieldsStep {
  if (unreadFields !== undefined && !unreadFields.length) {
    return { episode: undefined, started: false, raiseP2: false, resolved: episode };
  }
  if (unreadFields === undefined && !episode) {
    return { episode: undefined, started: false, raiseP2: false, resolved: undefined };
  }
  const open = openEpisode(episode, unreadFields, nowMs);
  const raiseP2 = !open.p2Raised && nowMs - open.sinceMs >= p2AfterMs;
  return {
    episode: raiseP2 ? { ...open, p2Raised: true } : open,
    started: episode === undefined,
    raiseP2,
    resolved: undefined,
  };
}

function openEpisode(
  episode: UnreadFieldsEpisode | undefined,
  unreadFields: readonly EnergyDistributionField[] | undefined,
  nowMs: number
): UnreadFieldsEpisode {
  if (!episode) return { sinceMs: nowMs, fields: unreadFields ?? [], p2Raised: false };
  if (unreadFields === undefined || unreadFields.join(",") === episode.fields.join(",")) return episode;
  return { ...episode, fields: unreadFields };
}
