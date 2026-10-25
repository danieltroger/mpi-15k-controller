/**
 * Owns the inverter serial device: termios setup via stty, open/reopen with backoff, raw byte
 * delivery. Deliberately zero dependencies (no serialport package, no native modules).
 *
 * Nothing here may touch the libuv threadpool. It is shared with every fs.promises call in the
 * process — on the pi chiefly the 15 one-wire thermometers, whose sysfs reads block a pool thread
 * for most of a second each — and at the first production cutover (2026-10-25) the old
 * FileHandle.write queued behind them for up to ~3 s. The session's response timer was already
 * running, so writes timed out before they reached the wire, retries doubled up (a GS retry and
 * the next PS hit the wire 1 ms apart) and responses got credited to the wrong command. So:
 * - reads: tty.ReadStream over a plain fd — libuv polls it on the event loop (verified by strace:
 *   read(2) runs on the main thread), and cable unplug surfaces as an EIO 'error';
 * - writes: writeSync on an O_NONBLOCK fd, on the main thread — a ≤20-byte frame lands in the
 *   ~4 kB tty output buffer at once, so it never blocks, and "written" means written;
 * - open/close: the sync calls (O_NONBLOCK, so a mis-set termios can't hang open(2) either).
 * inverterSession.pty.selftest.ts runs the whole engine with every pool thread blocked.
 */
import { closeSync, constants as fsConstants, openSync, writeSync } from "fs";
import tty from "tty";
import { exec } from "../utilities/exec.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";

// FTDI serial cable → inverter RS-232, NOT the inverter's USB-HID port: that port's firmware NAKs
// every command longer than 16 bytes (so MCHGV/DAT/BCA can never work there), while serial accepts
// the full PI17 command set. The by-id path survives re-enumeration; baud is the inverter's 2400.
export const INVERTER_SERIAL_DEVICE = "/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0";

const REOPEN_BACKOFF_INITIAL_MS = 1_000;
const REOPEN_BACKOFF_MAX_MS = 30_000;

export type SerialConnection = {
  /**
   * Write raw bytes to the device on the main thread; resolves once they are in the kernel's tty
   * buffer (immediately, in practice), rejects when the device is closed/unplugged
   */
  write(bytes: Buffer): Promise<void>;
  isOpen(): boolean;
  /** Permanently close (on owner cleanup) — stops the reopen loop */
  close(): void;
};

export function createSerialConnection({
  devicePath,
  onData,
  onOpen,
}: {
  devicePath: string;
  onData: (chunk: Buffer) => void;
  /** Called after each successful (re)open — the session flushes its reassembly buffer here */
  onOpen: () => void;
}): SerialConnection {
  const state: ConnectionState = {
    devicePath,
    onData,
    onOpen,
    current: undefined,
    closedForever: false,
    reopenTimer: undefined,
    backoffMs: REOPEN_BACKOFF_INITIAL_MS,
    openInProgress: false,
    consecutiveOpenFailures: 0,
  };
  void openDevice(state);
  return {
    write: bytes => writeToDevice(state, bytes),
    isOpen: () => state.current !== undefined,
    close: () => {
      state.closedForever = true;
      clearTimeout(state.reopenTimer);
      teardown(state);
    },
  };
}

type ConnectionState = {
  devicePath: string;
  onData: (chunk: Buffer) => void;
  onOpen: () => void;
  current: { readStream: tty.ReadStream; writeFd: number } | undefined;
  closedForever: boolean;
  reopenTimer: ReturnType<typeof setTimeout> | undefined;
  backoffMs: number;
  openInProgress: boolean;
  consecutiveOpenFailures: number;
};

async function openDevice(state: ConnectionState): Promise<void> {
  if (state.closedForever || state.current || state.openInProgress) return;
  state.openInProgress = true;
  try {
    // 8N1 raw line: `raw` switches off all line-discipline processing (incl. software flow
    // control), cs8/-parenb/-cstopb = 8 data bits, no parity, 1 stop bit, -crtscts = no hardware
    // flow control, clocal = don't wait for a modem carrier the three-wire cable doesn't have.
    // Matches pyserial's effective settings that mpp-solar used on this same cable.
    await exec(`stty -F ${state.devicePath} 2400 raw -echo cs8 -parenb -cstopb -crtscts clocal`);
    // Two independent opens of the same device: the read fd gets wrapped in tty.ReadStream, which
    // then owns it (destroy() closes it); the write fd stays ours to writeSync to and close.
    // O_NONBLOCK so a mis-set termios can never hang open(2); O_NOCTTY so the serial port cannot
    // become our controlling terminal.
    const readFd = openSync(state.devicePath, fsConstants.O_RDONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    let readStream: tty.ReadStream;
    try {
      readStream = new tty.ReadStream(readFd);
    } catch (streamError) {
      closeSync(readFd);
      throw streamError;
    }
    let writeFd: number;
    try {
      writeFd = openSync(state.devicePath, fsConstants.O_WRONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    } catch (openWriteError) {
      readStream.destroy();
      throw openWriteError;
    }
    state.current = { readStream, writeFd };
    readStream.on("data", chunk => state.onData(chunk));
    readStream.on("error", streamError => {
      errorLog("Inverter serial read stream errored (cable unplugged?)", streamError);
      teardownAndScheduleReopen(state);
    });
    readStream.on("close", () => {
      if (state.current?.readStream === readStream) {
        warnLog("Inverter serial read stream closed unexpectedly — reopening");
        teardownAndScheduleReopen(state);
      }
    });
    state.backoffMs = REOPEN_BACKOFF_INITIAL_MS;
    state.consecutiveOpenFailures = 0;
    logLog("Opened inverter serial device", state.devicePath);
    state.onOpen();
  } catch (openError) {
    state.consecutiveOpenFailures++;
    // Loud once per outage; each retry only warns (the mqtt-staleness P2 covers long outages)
    const logFailure = state.consecutiveOpenFailures === 1 ? errorLog : warnLog;
    logFailure(
      "Failed to open inverter serial device",
      state.devicePath,
      `(attempt ${state.consecutiveOpenFailures}, retrying in ${state.backoffMs} ms)`,
      openError
    );
    scheduleReopen(state);
  } finally {
    state.openInProgress = false;
  }
}

async function writeToDevice(state: ConnectionState, bytes: Buffer): Promise<void> {
  const connection = state.current;
  if (!connection) throw new Error(`Inverter serial device is not open (${state.devicePath})`);
  // O_NONBLOCK writes can be partial or EAGAIN if the ~4 kB tty buffer were full — never expected
  // for our ≤20-byte frames, one exchange at a time, but loop anyway so a partial write can't
  // split a frame. The EAGAIN pause is a timer on the event loop, not a pool job.
  let offset = 0;
  let eagainRetries = 0;
  while (offset < bytes.length) {
    try {
      // Runtime-wise Buffer IS a Uint8Array; the cast papers over @types/node 20 predating
      // TS 5.9's generic typed arrays (their slice() return types clash structurally)
      offset += writeSync(connection.writeFd, bytes as unknown as Uint8Array, offset);
    } catch (writeError) {
      const errorCode = (writeError as NodeJS.ErrnoException).code;
      if (errorCode === "EAGAIN" && ++eagainRetries <= 20) {
        await wait(10);
        continue;
      }
      if (errorCode === "EIO" || errorCode === "ENXIO" || errorCode === "ENODEV" || errorCode === "EBADF") {
        // The device is gone (unplug mid-write) — the read stream usually notices too, but don't rely on it
        errorLog("Inverter serial write failed with", errorCode, "— reopening device", writeError);
        teardownAndScheduleReopen(state);
      }
      throw writeError;
    }
  }
}

function teardown(state: ConnectionState): void {
  const connection = state.current;
  if (!connection) return;
  state.current = undefined;
  connection.readStream.destroy(); // also closes the read fd the stream owns
  try {
    closeSync(connection.writeFd);
  } catch (closeError) {
    warnLog("Failed to close inverter serial write fd", closeError);
  }
}

function teardownAndScheduleReopen(state: ConnectionState): void {
  teardown(state);
  scheduleReopen(state);
}

function scheduleReopen(state: ConnectionState): void {
  if (state.closedForever || state.reopenTimer) return;
  state.reopenTimer = setTimeout(() => {
    state.reopenTimer = undefined;
    void openDevice(state);
  }, state.backoffMs);
  state.backoffMs = Math.min(state.backoffMs * 2, REOPEN_BACKOFF_MAX_MS);
}
