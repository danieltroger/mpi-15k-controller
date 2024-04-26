export type InfoBroadcast = {
  energyDischargedSinceFull: number | undefined;
  energyChargedSinceFull: number | undefined;
  totalLastFull: string | 0 | undefined;
  energyRemovedSinceFull: number;
};
