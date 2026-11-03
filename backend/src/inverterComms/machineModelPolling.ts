/**
 * Whether a settings round reads the machine model (DM), pure. The DM answer format is from the spec only:
 * should this firmware not answer ^P003DM, every settings round would spend two 3 s timeouts on it. So a
 * DM that keeps failing backs off, and grid_off.poll_machine_model turns it off without a rollback. A DM
 * failure is not a link failure (GS/PS say whether the link is up). The confirms after a DM write read DM
 * regardless: a write must get its verdict.
 */

/** Consecutive unanswered DM queries before DM leaves the settings rounds for a while */
export const MACHINE_MODEL_FAILURES_BEFORE_BACKOFF = 2;
/** How long; after it one DM query is tried again, and one more failure backs off again */
export const MACHINE_MODEL_POLL_BACKOFF_MS = 30 * 60_000;

export type MachineModelPollState = {
  consecutiveFailures: number;
  /** Monotonic ms; undefined = not backed off */
  backedOffUntilMs: number | undefined;
};

export const INITIAL_MACHINE_MODEL_POLL_STATE: MachineModelPollState = {
  consecutiveFailures: 0,
  backedOffUntilMs: undefined,
};

/** Does this settings round read DM? */
export function machineModelPollDue(state: MachineModelPollState, nowMs: number, pollMachineModel: boolean): boolean {
  return pollMachineModel && (state.backedOffUntilMs === undefined || nowMs >= state.backedOffUntilMs);
}

/** After a DM query (poll or confirm): the new state, and whether this failure started a back-off */
export function afterMachineModelQuery(
  state: MachineModelPollState,
  answered: boolean,
  nowMs: number
): { state: MachineModelPollState; startedBackoff: boolean } {
  if (answered) return { state: INITIAL_MACHINE_MODEL_POLL_STATE, startedBackoff: false };
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures < MACHINE_MODEL_FAILURES_BEFORE_BACKOFF) {
    return { state: { consecutiveFailures, backedOffUntilMs: state.backedOffUntilMs }, startedBackoff: false };
  }
  return {
    state: { consecutiveFailures, backedOffUntilMs: nowMs + MACHINE_MODEL_POLL_BACKOFF_MS },
    startedBackoff: true,
  };
}
