/**
 * The energy-distribution enforcement's state as the ws carries it (EnergyDistributionStatus), assembled from
 * the wiring's signals. Pure: useEnergyDistributionEnforcement.ts calls it inside its status memo.
 */
import type { InverterEnergyDistributionConfig } from "../config/config.types.ts";
import { isWhitelistedMachineModel } from "../inverterComms/machineModel.ts";
import type { EnergyDistributionProfileName, EnergyDistributionStatus } from "./energyDistribution.types.ts";
import { ENERGY_DISTRIBUTION_FIELDS, PROFILE_BY_MACHINE_MODEL } from "./energyDistributionProfile.ts";
import {
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  type DivergenceEpisode,
  type HecsReading,
  type MachineModelReading,
} from "./energyDistributionEnforcementDecisions.ts";
import type { UnreadFieldsEpisode } from "./energyDistributionUnreadFields.ts";

export function energyDistributionStatus({
  machineModel,
  hecs,
  episode,
  unreadFieldsEpisode,
  judgedProfileName,
  settings,
  waitingReason,
  lastEvent,
}: {
  machineModel: MachineModelReading | undefined;
  hecs: HecsReading | undefined;
  episode: DivergenceEpisode | undefined;
  unreadFieldsEpisode: UnreadFieldsEpisode | undefined;
  /** The profile the latest step judged against; undefined = none judged (the DM readback's is shown then) */
  judgedProfileName: EnergyDistributionProfileName | undefined;
  settings: InverterEnergyDistributionConfig;
  waitingReason: string | undefined;
  lastEvent: EnergyDistributionStatus["last_event"];
}): EnergyDistributionStatus {
  const profileName: EnergyDistributionProfileName | undefined =
    judgedProfileName ??
    (machineModel && isWhitelistedMachineModel(machineModel.model)
      ? PROFILE_BY_MACHINE_MODEL[machineModel.model]
      : undefined);
  const shownProfile = settings[profileName ?? "normal_hybrid"];
  return {
    profile_name: profileName,
    machine_model: machineModel?.model,
    fields: ENERGY_DISTRIBUTION_FIELDS.map(field => {
      const inverterValue = hecs?.fields[field];
      return {
        field,
        desired: shownProfile[field],
        inverter: inverterValue === undefined ? undefined : String(inverterValue),
      };
    }),
    hecs_read_at: hecs?.decodedAtMs,
    divergence: episode && {
      since: episode.onsetMs,
      send_rounds: episode.sendRounds,
      p2_raised: episode.p2Raised,
      fallback_only: episode.changeTriggeredRetries >= CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
    },
    unread_fields: unreadFieldsEpisode && {
      fields: [...unreadFieldsEpisode.fields],
      since: unreadFieldsEpisode.sinceMs,
      p2_raised: unreadFieldsEpisode.p2Raised,
    },
    waiting_reason: waitingReason,
    last_event: lastEvent,
  };
}
