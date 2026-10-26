import { constants as fsConstants, promises as fs } from "fs";
import { wait } from "../vendor/depictUtilishared.ts";

/**
 * The file and clock operations a thermometer sweep needs. Production goes through node's fs promises,
 * i.e. the libuv thread pool, so a sysfs call that blocks in the kernel (the bulk trigger sleeps out the
 * whole conversion inside its write) never stalls the event loop. The selftest points the same sweep at a
 * fake sysfs directory and a simulated clock.
 */
export type SysfsAccess = {
  readText: (filePath: string) => Promise<string>;
  /** Writes into an existing file; never creates one. */
  writeText: (filePath: string, contents: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
  nowMs: () => number;
};

export const nodeSysfsAccess: SysfsAccess = {
  readText: filePath => fs.readFile(filePath, "utf8"),
  writeText: writeExistingFile,
  sleep: wait,
  nowMs: () => Date.now(),
};

/** One line for a log: node's fs errors already lead with their code ("EACCES: permission denied, open '…'"). */
export function describeFileError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.startsWith(code) ? `${code}: ${error.message}` : error.message;
}

async function writeExistingFile(filePath: string, contents: string) {
  // O_WRONLY without O_CREAT. fs.writeFile's "w" adds O_CREAT, and the kernel answers a create in a sysfs
  // directory with EACCES, so a missing attribute would read like a missing permission in the logs.
  const handle = await fs.open(filePath, fsConstants.O_WRONLY);
  try {
    // A single write() call: a sysfs store callback sees exactly what one write() carries.
    await handle.write(contents);
  } finally {
    await handle.close();
  }
}
