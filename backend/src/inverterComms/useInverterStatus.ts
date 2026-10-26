/**
 * Reactive wiring of the status tracker: every decoded round goes through inverterStatusTracking.ts,
 * its events go to the log, its out-of-cadence query wishes back to the session, and the status
 * itself into one signal (alerting reads it, the ws carries it to the /system page).
 */
import { type Accessor, createSignal, type Setter } from "solid-js";
import { debugLog, logLog, warnLog } from "../utilities/logging.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import type { InverterOperatingStatus, InverterStatusQuery } from "./inverterStatus.types.ts";
import {
  afterDecodedRound,
  INITIAL_INVERTER_STATUS_TRACKING,
  type InverterStatusTracking,
} from "./inverterStatusTracking.ts";
import { describeInverterStatusEvent } from "./inverterStatusLogText.ts";

export function createInverterStatusTracker(requestStatusQueries: (queries: readonly InverterStatusQuery[]) => void): {
  inverterStatus: Accessor<InverterOperatingStatus>;
  trackRound: (round: DecodedRound) => void;
} {
  const [inverterStatus, setInverterStatus] = createSignal<InverterOperatingStatus>(
    INITIAL_INVERTER_STATUS_TRACKING.status
  );
  const tracker: StatusTracker = {
    tracking: INITIAL_INVERTER_STATUS_TRACKING,
    setInverterStatus,
    requestStatusQueries,
  };
  return { inverterStatus, trackRound: round => trackRound(tracker, round) };
}

type StatusTracker = {
  tracking: InverterStatusTracking;
  setInverterStatus: Setter<InverterOperatingStatus>;
  requestStatusQueries: (queries: readonly InverterStatusQuery[]) => void;
};

function trackRound(tracker: StatusTracker, round: DecodedRound): void {
  const step = afterDecodedRound(tracker.tracking, round);
  const statusChanged = step.tracking.status !== tracker.tracking.status;
  tracker.tracking = step.tracking;
  // GS/PS rounds (~50/min) only move the DC-idle bookkeeping; don't wake status readers for them
  if (statusChanged) tracker.setInverterStatus(step.tracking.status);
  for (const event of step.events) {
    const { level, text } = describeInverterStatusEvent(event);
    if (level === "warn") warnLog(text);
    else if (level === "debug") debugLog(text);
    else logLog(text);
  }
  if (step.requestedQueries.length) tracker.requestStatusQueries(step.requestedQueries);
}
