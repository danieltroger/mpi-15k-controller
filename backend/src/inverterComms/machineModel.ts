/**
 * The PI17 machine model (DM) whitelist — pure, no I/O. The spec (Infini-Solar 10–15K, 2022-09-21):
 *   query  ^P003DM      → ^D006AAA<crc>\r, AAA the 3-digit model code
 *   setter ^S006DMnnn   → ^1 / ^0 (ACK / NAK)
 * DM is the grid code plus the operation mode in one number: 050–077 Hybrid with a certification,
 * 100–127 Grid-tie, 150 Off Grid (I/II), 151 Off Grid 3. Writing a wrong one can change the grid
 * code the inverter certifies itself under, so only the two codes this backend has a reason to
 * write ever reach the wire: 050 (what the inverter runs on) and 151 (Off-Grid III: on battery the
 * grid relay stays open; the grid takes the house over by itself on overload or a flat battery).
 */
import type { MachineModelCode } from "./pi17Protocol.types.ts";

export const NORMAL_HYBRID_MODEL: MachineModelCode = "050";
export const OFF_GRID_III_MODEL: MachineModelCode = "151";

const WHITELISTED_MACHINE_MODELS: ReadonlySet<string> = new Set<MachineModelCode>([
  NORMAL_HYBRID_MODEL,
  OFF_GRID_III_MODEL,
]);

/** How the page and the logs name a DM code */
export const MACHINE_MODEL_DESCRIPTIONS: Readonly<Record<MachineModelCode, string>> = {
  "050": "Normal hybrid (050)",
  "151": "Off-Grid III, grid relay open (151)",
};

export function isWhitelistedMachineModel(code: string | undefined): code is MachineModelCode {
  return code !== undefined && WHITELISTED_MACHINE_MODELS.has(code);
}

/** The DM readback described for a log line: a whitelisted code by name, anything else verbatim */
export function describeMachineModel(code: string | undefined): string {
  if (code === undefined) return "not read yet";
  return isWhitelistedMachineModel(code)
    ? MACHINE_MODEL_DESCRIPTIONS[code]
    : `unexpected model ${JSON.stringify(code)}`;
}

/** The setter for a whitelisted model (the type admits nothing else; machineModelSetterRefusal checks at runtime) */
export function machineModelSetterCommand(code: MachineModelCode): `DM${MachineModelCode}` {
  return `DM${code}`;
}

/** The only two DM commands that may ever reach the wire, compared as exact strings */
const WRITABLE_MACHINE_MODEL_COMMANDS: ReadonlySet<string> = new Set([
  machineModelSetterCommand(NORMAL_HYBRID_MODEL),
  machineModelSetterCommand(OFF_GRID_III_MODEL),
]);

/**
 * Why a setter must not go on the wire, or undefined when it may: every command that mentions DM in any
 * case or position ("dm151", " DM151", "XDM061") is refused unless it is exactly DM050 or DM151, whatever
 * its caller's types said (a cast or a future caller must not slip a grid-code change through), and so is
 * a command that isn't a string at all. No other setter the backend sends contains "dm".
 */
export function machineModelSetterRefusal(command: unknown): string | undefined {
  if (typeof command !== "string") return `setter ${String(command)} refused: not a string`;
  if (!/dm/i.test(command)) return undefined;
  if (WRITABLE_MACHINE_MODEL_COMMANDS.has(command)) return undefined;
  return `machine model setter ${JSON.stringify(command)} refused: only DM${NORMAL_HYBRID_MODEL} and DM${OFF_GRID_III_MODEL} may be written`;
}
