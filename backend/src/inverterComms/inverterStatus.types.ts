/**
 * The inverter's own operating status (PI17 MOD / CFS / WS / HFS) as the backend tracks it — pure
 * types, no runtime imports: the frontend renders InverterOperatingStatus from the ws, and the
 * alert rules read it (CLAUDE.md on shared wire types). All times are wall-clock ms.
 */

/** PI17 MOD answer codes (2022 spec): 04 is the latched-fault state of 2026-10-21 */
export type InverterWorkingModeCode = "00" | "01" | "02" | "03" | "04" | "05" | "06";

export type InverterWorkingModeReading = {
  code: InverterWorkingModeCode;
  /** The PI17 spec's name, e.g. "Fault mode" */
  text: string;
  /** First reading of this mode in the current run of it (since the controller started at the earliest) */
  since: number;
  /**
   * Whether `since` is the onset: a reading of another mode came before it. False for the first
   * reading after the controller started — the mode may have held long before ("at least since").
   */
  since_is_onset: boolean;
  /** Newest reading */
  time: number;
};

/**
 * CFS: the LATEST fault the inverter recorded. Sticky — it still read 14 two days after the
 * 2026-10-21 latch had been cleared — so it is never an "active fault" flag; only the working mode
 * says that.
 */
export type InverterLatestFaultReading = {
  code: number;
  /** "F14 Inverter DC current exceed permit range when feed power" */
  text: string;
  /** Flash slot (0–8) of the latest stored fault record */
  record_id: number;
  /** First reading of this code + record id */
  since: number;
  time: number;
};

export type InverterWarningsReading = {
  /** Human-readable names of the WS flags that are set, in protocol order */
  active: string[];
  time: number;
};

/** One HFS slot as read from the inverter's flash */
export type InverterFaultRecord = {
  record_id: number;
  fault_code: number;
  fault_text: string;
  /** YYMMDDhhmmss per the spec; this firmware's slot 00 reads 759900560005, so treat it as opaque */
  recorded_at_text: string;
  /** The working mode stored with the record: its name when it is a known code, else the raw code */
  work_mode: string;
  /**
   * The 21 value-snapshot tokens after the first four fields, comma-joined and verbatim: the spec's
   * field alignment looks shifted by one on this firmware (2026-10 forensics: the "battery voltage"
   * slot reads 759.9 V), so nothing here is interpreted.
   */
  snapshot: string;
  time: number;
};

export type InverterOperatingStatus = {
  working_mode: InverterWorkingModeReading | undefined;
  latest_fault: InverterLatestFaultReading | undefined;
  warnings: InverterWarningsReading | undefined;
  /** Every slot that answered with a record, by ascending record id */
  fault_records: InverterFaultRecord[];
};

export type FaultRecordId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * The status queries as they go on the wire. HFS carries its slot as a two-digit argument
 * (^P006HFS03), which is why these are wire strings rather than decode-table names.
 */
export type InverterStatusQuery = "MOD" | "CFS" | "WS" | `HFS0${FaultRecordId}`;
