/**
 * PI17 fault codes (CFS / HFS) → human text — pure data.
 *
 * Sources: the MPI 15KW WP manual §17-2 "Fault Reference Codes" (what the LCD's code means on this
 * model), and the vendor's fuller wording where it is known: the official PI17 spec "Infini-Solar
 * WP LV6K_3P 10-15K and TWIN Series protocol 20220921", whose English texts are also what the
 * vendor cloud displays (it rendered the 2026-10-21 latch as "14-Inverter DC current exceed permit
 * range when feed power"). Where the two disagree on a code, the manual's reading comes first and
 * the spec's is quoted after it: the firmware never says which one it means, and the cloud sent
 * the 2025-06-30 F57 with no text at all. Codes in neither list render as unknown.
 */
export function describeInverterFaultCode(code: number): string {
  if (code === 0) return "F00 (no fault recorded)";
  const label = `F${String(code).padStart(2, "0")}`;
  const text = INVERTER_FAULT_CODE_TEXTS[code];
  return text ? `${label} ${text}` : `${label} (not in the manual's or the PI17 spec's fault list)`;
}

export const INVERTER_FAULT_CODE_TEXTS: Readonly<Record<number, string>> = {
  1: "BUS voltage exceeds the upper limit",
  2: "BUS voltage dropped below the lower limit",
  3: "BUS soft start circuit timeout",
  4: "Inverter voltage soft start timeout",
  5: "Inverter current exceeds the upper limit",
  6: "Over temperature",
  7: "Inverter relay abnormal",
  8: "Current sample abnormal while the inverter is not working (CT sensor fault)",
  9: "Solar input voltage exceeds the upper limit",
  10: "SPS (auxiliary) power supply voltage abnormal",
  11: "Solar input current exceeds the upper limit",
  12: "Leakage current exceed permit range (GFCI fault)",
  13: "Solar insulation resistance too low (PV ISO fault)",
  // The vendor cloud's exact wording for the 2026-10-21 latch; the manual only says "INV DC current over"
  14: "Inverter DC current exceed permit range when feed power",
  15: "AC input voltage or frequency differs between the master and slave CPU",
  16: "Leakage current detection circuit abnormal while the inverter is not working (GFCI sensor fault)",
  17: "Communication lost between the master and slave CPU",
  18: "Communication data mismatch between the master and slave CPU",
  19: "AC input ground wire lost",
  22: "Battery voltage exceeds the upper limit",
  23: "Overload (more than 110 % load for too long)",
  24: "S-phase inverter current exceeds the upper limit",
  25: "T-phase inverter current exceeds the upper limit",
  26: "AC output short circuit",
  27: "Fan lock",
  32: "Battery DC-DC over current",
  33: "AC output voltage too low",
  34: "AC output voltage too high",
  35: "Control board wiring error",
  36: "OP voltage fault: grid connected to the output terminal (PI17 spec: AC circuit voltage sample error)",
  37: "AC N wire over current",
  38: "Short circuit on PV input",
  39: "S-phase AC output voltage too low",
  40: "T-phase AC output voltage too low",
  41: "S-phase AC output voltage too high",
  42: "T-phase AC output voltage too high",
  46: "RS inverter short circuit",
  47: "ST inverter short circuit",
  48: "TR inverter short circuit",
  49: "BUCK BOOST over temperature",
  50: "Relay version error",
  51: "External battery over temperature",
  52: "PV1 over temperature",
  53: "PV2 over temperature",
  54: "Inverter over temperature (PI17 spec: N-bat over temperature)",
  55: "R-phase inverter over temperature",
  56: "DCDC over temperature (PI17 spec: S-phase inverter over temperature)",
  57: "Control board over temperature (PI17 spec: T-phase inverter over temperature)",
  58: "External battery over temperature (PI17 spec: PDCDC over temperature)",
  59: "Battery DC/DC board over temperature",
  60: "Negative power detected",
  61: "Driver signal lost from the relay board",
  62: "Communication lost between the main board and the relay board",
  63: "Main board and relay board versions differ",
  71: "Parallel version incompatible",
  72: "Output current detection abnormal",
  80: "CAN lost",
  81: "HOST lost",
  82: "SYN lost",
  88: "BUS balance over current",
};
