/**
 * Owns the inverter serial device: termios setup via stty, open/reopen with backoff, raw byte
 * delivery. Deliberately zero dependencies (no serialport package, no native modules).
 *
 * Nothing here may touch the libuv threadpool. It is shared with every fs.promises call in the
 * process — on the pi chiefly the 15 one-wire thermometers, whose sysfs reads block a pool thread
 * for ~750 ms each — and at the first production cutover (2026-10-25) the old FileHandle.write
 * queued behind them for up to ~3 s. The session's response timer was already running, so writes
 * timed out before they reached the wire, retries doubled up (a GS retry and the next PS hit the
 * wire 1 ms apart) and responses got credited to the wrong command.
 *
 * So both directions go through ONE libuv tty stream on the event loop: the device is opened
 * O_RDWR|O_NONBLOCK and wrapped in a tty.ReadStream, which — despite its name — is a full
 * net.Socket Duplex over a uv_tty handle. libuv keeps the fd non-blocking, reads arrive as 'data'
 * events, and stream.write() performs a non-blocking write(2) from the event loop (queueing on
 * EAGAIN, never blocking JS) with its completion delivered as the write callback — which is what
 * the session's response timer starts on. Verified on Node 24 with strace: read(2) and write(2)
 * both run on the JS thread. The obvious alternatives are wrong here: tty.WriteStream forces the
 * fd into BLOCKING mode (setBlocking(true), for terminal stdout ordering), net.Socket({ fd })
 * rejects tty fds (ERR_INVALID_FD_TYPE), and fs writes are threadpool jobs.
 *
 * The open is a one-off openSync with O_NONBLOCK, but libuv's tty init then reopens the device by
 * name with a blocking open(2) — which can't wait for a carrier only because stty set clocal, so
 * that is asserted before every open (see openDevice). inverterSession.pty.selftest.ts runs the
 * whole engine with every pool thread blocked; inverterLifecycle.pty.selftest.ts covers close
 * during open, fd stability across reopens, and a replugged device.
 */
import { closeSync, constants as fsConstants, openSync } from "fs";
import tty from "tty";
import { exec } from "../utilities/exec.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

// FTDI serial cable → inverter RS-232, NOT the inverter's USB-HID port: that port's firmware NAKs
// every command longer than 16 bytes (so MCHGV/DAT/BCA can never work there), while serial accepts
// the full PI17 command set. The by-id path survives re-enumeration; baud is the inverter's 2400.
export const INVERTER_SERIAL_DEVICE = "/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A50285BI-if00-port0";

const REOPEN_BACKOFF_INITIAL_MS = 1_000;
const REOPEN_BACKOFF_MAX_MS = 30_000;

export type SerialConnection = {
  /**
   * Queue raw bytes on the device stream; resolves when libuv reports the write complete (the
   * bytes are in the kernel's tty buffer), rejects when the device is closed/unplugged
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
    deviceStream: undefined,
    closedForever: false,
    reopenTimer: undefined,
    backoffMs: REOPEN_BACKOFF_INITIAL_MS,
    openInProgress: false,
    consecutiveOpenFailures: 0,
  };
  void openDevice(state);
  return {
    write: bytes => writeToDevice(state, bytes),
    isOpen: () => state.deviceStream !== undefined,
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
  /** The one read+write stream over the device (a tty.ReadStream opened O_RDWR — see the header) */
  deviceStream: tty.ReadStream | undefined;
  closedForever: boolean;
  reopenTimer: ReturnType<typeof setTimeout> | undefined;
  backoffMs: number;
  openInProgress: boolean;
  consecutiveOpenFailures: number;
};

async function openDevice(state: ConnectionState): Promise<void> {
  if (state.closedForever || state.deviceStream || state.openInProgress) return;
  state.openInProgress = true;
  try {
    // 8N1 raw line: `raw` switches off all line-discipline processing (incl. software flow
    // control), cs8/-parenb/-cstopb = 8 data bits, no parity, 1 stop bit, -crtscts = no hardware
    // flow control, clocal = don't wait for a modem carrier the three-wire cable doesn't have.
    // Matches pyserial's effective settings that mpp-solar used on this same cable. Read back (-a)
    // in the same exec, because the open below depends on clocal (see there).
    const { stdout: termiosReadback } = await exec(
      `stty -F ${state.devicePath} 2400 raw -echo cs8 -parenb -cstopb -crtscts clocal && stty -F ${state.devicePath} -a`
    );
    // close() may have run while stty was executing (a main() crash during boot does exactly that)
    if (state.closedForever) return;
    if (!termiosReadback.split(/\s+/).includes("clocal")) {
      throw new Error(`stty did not leave clocal set on ${state.devicePath} — refusing a possibly hanging open`);
    }
    // O_NOCTTY so the serial port cannot become our controlling terminal. O_NONBLOCK keeps THIS
    // open from waiting for a carrier — but libuv's tty init then reopens the device by name with
    // a BLOCKING open(2) (to get a file description of its own to make non-blocking) and dup2s it
    // over deviceFd. That reopen can only hang on a missing carrier if clocal were off, hence the
    // assertion above.
    const deviceFd = openSync(state.devicePath, fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    let deviceStream: tty.ReadStream;
    try {
      deviceStream = new tty.ReadStream(deviceFd);
    } catch (streamError) {
      closeSync(deviceFd);
      throw streamError;
    }
    // After that reopen the stream's handle uses libuv's own fd, and destroy() closes only that one:
    // our fd (now a duplicate) would leak once per (re)open unless we close it here.
    const handleFd = (deviceStream as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (handleFd !== undefined && handleFd !== deviceFd) closeSync(deviceFd);
    if (!deviceStream.writable) {
      deviceStream.destroy();
      throw new Error(`tty stream over ${state.devicePath} is not writable — opened without write access?`);
    }
    state.deviceStream = deviceStream;
    deviceStream.on("data", (chunk: Buffer) => state.onData(chunk));
    deviceStream.on("error", streamError => {
      errorLog("Inverter serial stream errored (cable unplugged?)", streamError);
      teardownAndScheduleReopen(state);
    });
    deviceStream.on("close", () => {
      if (state.deviceStream === deviceStream) {
        warnLog("Inverter serial stream closed unexpectedly — reopening");
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

function writeToDevice(state: ConnectionState, bytes: Buffer): Promise<void> {
  const deviceStream = state.deviceStream;
  if (!deviceStream) return Promise.reject(new Error(`Inverter serial device is not open (${state.devicePath})`));
  return new Promise<void>((resolve, reject) => {
    // A failed write also errors (and destroys) the stream, whose 'error' handler logs and reopens
    // — so the callback only has to hand the failure to the waiting exchange.
    // Runtime-wise Buffer IS a Uint8Array; the cast papers over @types/node 20 predating TS 5.9's
    // generic typed arrays (their slice() return types clash structurally)
    deviceStream.write(bytes as unknown as Uint8Array, writeError => (writeError ? reject(writeError) : resolve()));
  });
}

function teardown(state: ConnectionState): void {
  const deviceStream = state.deviceStream;
  if (!deviceStream) return;
  state.deviceStream = undefined;
  deviceStream.destroy(); // also closes the fd the stream owns
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
