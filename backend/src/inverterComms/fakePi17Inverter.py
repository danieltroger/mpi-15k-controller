#!/usr/bin/env python3
"""
Fake MPI 15K speaking PI17 on a pty — the far end for inverterSession.pty.selftest.ts.

Answers GS/PS/GPMP/HECS/BATS queries and ACKs setters (committing them ~0.6 s later, like the real
inverter's ACK != commit), dribbling bytes at 2400-baud speed in FTDI-sized chunks. A fixed fault
plan replays what broke the first production cutover (2026-10-25) and more:

  GS #3   a stale PS frame goes out first, then the GS answer   (PS frame while GS is in flight)
  PS #3   a stale GS frame first, then the PS answer            (GS frame while PS is in flight)
  setter 1  a stale PS data frame first, then the ACK
  GS #5   never answered                                        (lost response -> timeout + retry)
  GS #7   answered 3.15 s late                                  (after the session's 3 s timeout)
  GS #9   a well-shaped GS with battery_voltage 30.9 V          (must be dropped by the gate)
  GS #11  a CRC-corrupted GS frame first, then the real answer

Every frame carries a serial number (GS: inner_temperature, PS: solar_input_power_2) so the
harness can map each decoded round back to the exact frame it came from. Events go to stdout as
JSON lines; the harness closing our stdin ends the run.
"""
import json
import os
import select
import sys
import time
import tty

BYTES_PER_SECOND = 240  # 2400 baud, 8N1
CHUNK_BYTES = 4  # roughly what the FTDI hands the host per USB poll
RESPONSE_LATENCY_S = 0.04  # the live inverter starts answering within ~50 ms
COMMIT_DELAY_S = 0.6
LATE_RESPONSE_DELAY_S = 3.15

ACK = b"^1\x0b\xc2\r"

# Live tokens (2026-10-25 captures); the serial-number slots get overwritten per frame
GS_TOKENS = "03482,03256,0021,0026,0532,073,-00098,2363,2352,2358,5004,0000,0000,0000,2361,2352,2358,5008,,,,036,053,000,0".split(",")
PS_TOKENS = "00080,00085,,+00008,-00175,-00054,-00237,00223,00076,00189,00488,00259,00076,00212,00547,003,1,1,1,2,2,2".split(",")
BATS_TOKENS = "3000,0580,0580,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375".split(",")
GS_INNER_TEMPERATURE_INDEX = 21
GS_BATTERY_VOLTAGE_INDEX = 4
PS_SOLAR_POWER_2_INDEX = 1


def crc16_xmodem(data):
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def data_frame(payload):
    body = b"^D" + b"%03d" % (len(payload) + 3) + payload.encode("latin1")
    crc = crc16_xmodem(body)
    return body + bytes([crc >> 8, crc & 0xFF, 0x0D])


def emit(event, **fields):
    print(json.dumps({"event": event, "t": time.monotonic(), **fields}), flush=True)


class FakeInverter:
    def __init__(self, master_fd):
        self.master_fd = master_fd
        self.serial = 0
        self.counts = {}
        self.setters_seen = 0
        self.gpmp = 350
        self.charge_voltage_tenths = (580, 580)
        self.max_ac_charging_tenths = 100
        self.pending_commits = []  # (apply_at, description, apply_fn)
        self.queued = []  # responses: dict(start_at, chunks, role, answering, serial, kind, sent)
        self.last_tx_byte_at = time.monotonic()
        self.overlaps = 0
        self.next_command_follows_anomaly = False
        self.faults_remaining = {"gs3", "ps3", "setter1", "gs5", "gs7", "gs9", "gs11"}

    # ---------- frames ----------
    def next_serial(self):
        self.serial += 1
        return self.serial

    def gs_frame(self, battery_voltage_token=None):
        serial = self.next_serial()
        tokens = list(GS_TOKENS)
        tokens[GS_INNER_TEMPERATURE_INDEX] = "%03d" % (serial % 100)
        if battery_voltage_token:
            tokens[GS_BATTERY_VOLTAGE_INDEX] = battery_voltage_token
        return data_frame(",".join(tokens)), serial

    def ps_frame(self):
        serial = self.next_serial()
        tokens = list(PS_TOKENS)
        tokens[PS_SOLAR_POWER_2_INDEX] = "%05d" % serial
        return data_frame(",".join(tokens)), serial

    def settings_frame(self, command):
        if command == "GPMP":
            return data_frame("%05d" % self.gpmp), None
        if command == "HECS":
            return data_frame("00,1,0,1,1,1,1,1,0"), None
        tokens = list(BATS_TOKENS)
        tokens[1] = "%04d" % self.charge_voltage_tenths[0]
        tokens[2] = "%04d" % self.charge_voltage_tenths[1]
        tokens[16] = "%04d" % self.max_ac_charging_tenths
        return data_frame(",".join(tokens)), None

    # ---------- transmission ----------
    def queue(self, frame, frame_command, answering, role, serial, delay_s=RESPONSE_LATENCY_S):
        """frame_command: what the frame contains; answering: the command it goes out in response to"""
        # Back-to-back after whatever is already queued, like a UART would send it
        start_at = max(time.monotonic() + delay_s, self.queue_end())
        chunks = []
        for offset in range(0, len(frame), CHUNK_BYTES):
            chunk = frame[offset : offset + CHUNK_BYTES]
            chunks.append((start_at, chunk))
            start_at += len(chunk) / BYTES_PER_SECOND
        self.queued.append(
            {"chunks": chunks, "frame_command": frame_command, "answering": answering, "role": role, "serial": serial, "sent": 0}
        )

    def queue_end(self):
        return max((response["chunks"][-1][0] for response in self.queued), default=0)

    def next_wakeup(self):
        times = [response["chunks"][response["sent"]][0] for response in self.queued]
        times += [apply_at for apply_at, _, _ in self.pending_commits]
        return min(times) if times else None

    def pump_output(self):
        now = time.monotonic()
        for response in list(self.queued):
            while response["sent"] < len(response["chunks"]) and response["chunks"][response["sent"]][0] <= now:
                os.write(self.master_fd, response["chunks"][response["sent"]][1])
                response["sent"] += 1
                self.last_tx_byte_at = time.monotonic()
            if response["sent"] == len(response["chunks"]):
                self.queued.remove(response)
                emit(
                    "frame_sent",
                    frame_command=response["frame_command"],
                    answering=response["answering"],
                    role=response["role"],
                    serial=response["serial"],
                )
        for commit in list(self.pending_commits):
            if commit[0] <= now:
                self.pending_commits.remove(commit)
                commit[2]()
                emit("committed", setter=commit[1])

    def busy_with_live_response(self):
        # Transmitting, or about to answer on schedule. A deliberately late answer that hasn't
        # started yet doesn't count: the session has (correctly) given up on it by then.
        now = time.monotonic()
        return any(response["role"] != "late" or response["chunks"][0][0] <= now for response in self.queued)

    # ---------- commands ----------
    def handle_command(self, command_bytes):
        now = time.monotonic()
        overlap = self.busy_with_live_response()
        if overlap:
            self.overlaps += 1
        text = command_bytes.decode("latin1")
        emit(
            "received",
            command=text,
            overlap=overlap,
            ms_since_last_tx_byte=round((now - self.last_tx_byte_at) * 1000),
            follows_anomaly=self.next_command_follows_anomaly,
        )
        self.next_command_follows_anomaly = False
        if text.startswith("^S"):
            self.handle_setter(text[5:])
        elif text.startswith("^P"):
            self.handle_query(text[5:])
        else:
            emit("unparseable_command", command=text)

    def handle_query(self, command):
        count = self.counts[command] = self.counts.get(command, 0) + 1
        if command == "GS":
            if count == 3 and "gs3" in self.faults_remaining:
                self.fault_done("gs3")
                stale, stale_serial = self.ps_frame()
                self.queue(stale, "PS", "GS", "stale", stale_serial)
                self.next_command_follows_anomaly = True
            if count == 5 and "gs5" in self.faults_remaining:
                self.fault_done("gs5")
                emit("lost", answering="GS")
                self.next_command_follows_anomaly = True
                return
            if count == 7 and "gs7" in self.faults_remaining:
                self.fault_done("gs7")
                frame, serial = self.gs_frame()
                self.queue(frame, "GS", "GS", "late", serial, delay_s=LATE_RESPONSE_DELAY_S)
                return
            if count == 9 and "gs9" in self.faults_remaining:
                self.fault_done("gs9")
                frame, serial = self.gs_frame(battery_voltage_token="0309")
                self.queue(frame, "GS", "GS", "implausible", serial)
                return
            if count == 11 and "gs11" in self.faults_remaining:
                self.fault_done("gs11")
                corrupt, corrupt_serial = self.gs_frame()
                corrupt = corrupt[:10] + bytes([corrupt[10] ^ 0x01]) + corrupt[11:]
                self.queue(corrupt, "GS", "GS", "corrupt", corrupt_serial)
                self.next_command_follows_anomaly = True
            frame, serial = self.gs_frame()
            self.queue(frame, "GS", "GS", "answer", serial)
        elif command == "PS":
            if count == 3 and "ps3" in self.faults_remaining:
                self.fault_done("ps3")
                stale, stale_serial = self.gs_frame()
                self.queue(stale, "GS", "PS", "stale", stale_serial)
                self.next_command_follows_anomaly = True
            frame, serial = self.ps_frame()
            self.queue(frame, "PS", "PS", "answer", serial)
        elif command in ("GPMP", "HECS", "BATS"):
            frame, serial = self.settings_frame(command)
            self.queue(frame, command, command, "answer", serial)
        else:
            emit("unknown_query", command=command)

    def handle_setter(self, command):
        self.setters_seen += 1
        if self.setters_seen == 1 and "setter1" in self.faults_remaining:
            self.fault_done("setter1")
            stale, stale_serial = self.ps_frame()
            self.queue(stale, "PS", command, "stale", stale_serial)
            self.next_command_follows_anomaly = True
        self.queue(ACK, "ACK", command, "answer", None)
        apply_at = time.monotonic() + COMMIT_DELAY_S
        if command.startswith("GPMP0"):
            watts = int(command[5:])
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "gpmp", watts)))
        elif command.startswith("MCHGV"):
            bulk, floating = (int(value) for value in command[5:].split(","))
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "charge_voltage_tenths", (bulk, floating))))
        elif command.startswith("MUCHGC"):
            amps_tenths = int(command[6:])
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "max_ac_charging_tenths", amps_tenths)))

    def fault_done(self, fault):
        self.faults_remaining.discard(fault)
        emit("fault", fault=fault)
        if not self.faults_remaining:
            emit("faults_done")


def main():
    master_fd, slave_fd = os.openpty()
    # Raw + no echo on the slave side so nothing we send is reflected back at us; keeping our own
    # slave fd open also stops master reads from failing with EIO before the session opens it.
    tty.setraw(slave_fd)
    inverter = FakeInverter(master_fd)
    emit("ready", device=os.ttyname(slave_fd))
    received = b""
    while True:
        wakeup = inverter.next_wakeup()
        timeout = 0.05 if wakeup is None else max(0.0, min(0.05, wakeup - time.monotonic()))
        readable, _, _ = select.select([master_fd, sys.stdin], [], [], timeout)
        if sys.stdin in readable and not sys.stdin.buffer.read1(1024):
            emit("summary", overlaps=inverter.overlaps, counts=inverter.counts, faults_remaining=sorted(inverter.faults_remaining))
            return
        if master_fd in readable:
            received += os.read(master_fd, 1024)
            while b"\r" in received:
                command, received = received.split(b"\r", 1)
                start = command.find(b"^")
                if start == -1:
                    emit("garbage", data=command.hex())
                    continue
                inverter.handle_command(command[start:])
        inverter.pump_output()


if __name__ == "__main__":
    main()
