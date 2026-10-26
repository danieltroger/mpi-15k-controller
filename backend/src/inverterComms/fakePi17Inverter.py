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
  GS #13  an answer with a "mixed" CRC — one byte 0x00, the other one the firmware bumps
          (000a 000d 0028 0a00 0d00 2800: what the first bump fix still rejected; must be accepted)
  EDF     the first EDF setter goes unanswered; when its retry arrives the first attempt's late ACK
          goes out at once and the retry's own NAK 150 ms later — the NAK must not be credited to
          the next setter of the burst

Like the real firmware, every CRC byte that would be 0x0A/0x0D/0x28 is sent as that byte + 1 (found
live at the second cutover attempt, 2026-10-25; 0x00 is not bumped), so ~2.3 % of all frames
exercise it anyway. EDx setters change the HECS readback, GPMP0/MCHGV/MUCHGC theirs.

The status queries answer like this inverter did in October 2026: MOD 05 (Hybrid), CFS 12,00 (the
latest fault before the incident), WS all clear, and HFS00-08 the nine records it returned on
2026-10-26 (each naming slot 00 in its own id field); a slot it held no record for would be
declined with a NAK.
EDB0 (AC charging off: the end of a buy window) latches fault 14 the way 2026-10-21 did: MOD 04,
CFS 14,00 (slot 00 again, as the real firmware kept it), battery 0 A and Idle/Idle in GS/PS. The
latch commits like any other write, on the commit timing below.

Commit behaviour for the quiet-gap experiment harness (quietGapExperiment.pty.selftest.ts), the
two readings of the July 2026 evidence:
  --commit-delay-s S        every write commits S seconds after it arrives, whatever the traffic
  --commit-needs-quiet-s Q  a write commits only once no command has arrived for Q seconds, so
                            continuous polling starves it forever
  --no-faults               skip the fault plan above

Every frame carries a serial number (GS: inner_temperature, PS: solar_input_power_2) so the
harness can map each decoded round back to the exact frame it came from. Events go to stdout as
JSON lines; the harness closing our stdin ends the run.
"""
import argparse
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
NAK = b"^0\x1b\xe3\r"

# Live tokens (2026-10-25 captures); the serial-number slots get overwritten per frame
GS_TOKENS = "03482,03256,0021,0026,0532,073,-00098,2363,2352,2358,5004,0000,0000,0000,2361,2352,2358,5008,,,,036,053,000,0".split(",")
PS_TOKENS = "00080,00085,,+00008,-00175,-00054,-00237,00223,00076,00189,00488,00259,00076,00212,00547,003,1,1,1,2,2,2".split(",")
BATS_TOKENS = "3000,0580,0580,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375".split(",")
GS_INNER_TEMPERATURE_INDEX = 21
GS_BATTERY_VOLTAGE_INDEX = 4
GS_BATTERY_CURRENT_INDEX = 6
PS_SOLAR_POWER_2_INDEX = 1
PS_BATTERY_DIRECTION_INDEX = 19
PS_DC_AC_DIRECTION_INDEX = 20
# The datalogger's raw uploads, 2026-10-23..25 (fault_forensics.md section 3.2)
MOD_HYBRID = "05"
MOD_FAULT = "04"
CFS_BEFORE_LATCH = "12,00"
CFS_AFTER_LATCH = "14,00"
WS_ALL_CLEAR = ",".join(["0"] * 23)
# What the real inverter returned for HFS00..HFS08 on 2026-10-26: F14, F12, F12, F12, F14, F23, F57, F14, F12
HFS_RECORDS = [
    "00,14,759900010005,66,01070,00000,00014,02371,2354,2350,5000,0544,7599,+0365,2354,2352,5003,0094,00069,00189,00002,042,059,000,000",
    "00,12,759900560005,04,05850,00012,00080,02313,2296,2298,4996,0410,7599,+0309,2294,2300,4996,0115,00045,00138,00001,029,046,000,000",
    "00,12,759900070005,15,05913,00009,00088,02318,2358,2386,4998,0411,7599,+0328,2356,0000,5001,1321,00237,00166,00013,029,046,000,000",
    "00,12,759900160005,41,05940,00011,00085,02378,2326,2367,4994,0412,7599,+0380,2326,2367,4992,0309,00255,00236,00005,029,046,000,000",
    "00,14,759900550005,47,01105,00000,00009,02236,2197,2172,4993,0529,7599,+0236,2193,2174,4993,0139,00250,00203,00003,039,056,000,000",
    "00,23,759900310003,37,06947,00000,00053,00000,0000,0000,0000,0523,7599,+0303,2300,2300,5000,5706,05694,05745,00114,048,071,000,000",
    "00,57,759900560005,84,06296,00000,00000,02464,2468,2466,5002,0518,7599,+0466,2462,2462,4996,0221,00247,00221,00004,080,099,000,000",
    "00,14,759900410005,39,01124,00000,00017,02376,2245,2380,5000,0513,7599,+0378,2251,2365,5013,0095,00375,00189,00004,036,058,000,000",
    "00,12,759900540005,62,06392,00000,00094,02294,2363,2277,4998,0108,7599,+0296,2361,2279,4996,1612,00611,01046,00021,035,051,000,000",
]


def crc16_xmodem(data):
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


CRC_BYTES_THE_FIRMWARE_BUMPS = {0x0A, 0x0D, 0x28}
MIXED_CRCS = {0x000A, 0x000D, 0x0028, 0x0A00, 0x0D00, 0x2800}
GS_AC_OUTPUT_FREQUENCY_INDEX = 17


def data_frame_body(payload):
    return b"^D" + b"%03d" % (len(payload) + 3) + payload.encode("latin1")


def crc16_xmodem_continued(crc, data):
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def data_frame(payload):
    body = data_frame_body(payload)
    crc = crc16_xmodem(body)
    crc_bytes = [crc >> 8, crc & 0xFF]
    crc_bytes = [crc_byte + 1 if crc_byte in CRC_BYTES_THE_FIRMWARE_BUMPS else crc_byte for crc_byte in crc_bytes]
    return body + bytes(crc_bytes + [0x0D])


def emit(event, **fields):
    print(json.dumps({"event": event, "t": time.monotonic(), **fields}), flush=True)


class FakeInverter:
    def __init__(self, master_fd, commit_delay_s, commit_needs_quiet_s, with_faults):
        self.master_fd = master_fd
        self.commit_delay_s = commit_delay_s
        self.commit_needs_quiet_s = commit_needs_quiet_s
        self.commits_deferred_by_traffic = 0
        self.serial = 0
        self.counts = {}
        self.setters_seen = 0
        self.gpmp = 350
        self.charge_voltage_tenths = (580, 580)
        self.max_ac_charging_tenths = 100
        # priority, then EDA..EDG (solar charge, AC charge, feed utility, discharge loads x2, feed grid x2), reserved
        self.hecs_tokens = ["00", "1", "0", "1", "1", "1", "1", "1", "0"]
        self.fault_14_latched = False
        self.held_first_edf = None
        self.pending_commits = []  # (apply_at, description, apply_fn)
        self.queued = []  # responses: dict(start_at, chunks, role, answering, serial, kind, sent)
        self.last_tx_byte_at = time.monotonic()
        self.overlaps = 0
        self.next_command_follows_anomaly = False
        all_faults = {"gs3", "ps3", "setter1", "gs5", "gs7", "gs9", "gs11", "gs13", "edf_late"}
        self.faults_remaining = all_faults if with_faults else set()

    # ---------- frames ----------
    def next_serial(self):
        self.serial += 1
        return self.serial

    def gs_frame(self, battery_voltage_token=None, force_mixed_crc=False):
        serial = self.next_serial()
        tokens = list(GS_TOKENS)
        tokens[GS_INNER_TEMPERATURE_INDEX] = "%03d" % (serial % 100)
        if self.fault_14_latched:
            tokens[GS_BATTERY_CURRENT_INDEX] = "+00000"
        if battery_voltage_token:
            tokens[GS_BATTERY_VOLTAGE_INDEX] = battery_voltage_token
        if force_mixed_crc:
            return self.gs_frame_with_mixed_crc(tokens), serial
        return data_frame(",".join(tokens)), serial

    def gs_frame_with_mixed_crc(self, tokens):
        # Vary the output frequency (49.90-50.10 Hz) and the two spare temperatures (all still
        # plausible) until the computed CRC is one of the six mixed values; the fixed prefix's CRC
        # is computed once and continued over the varied tail.
        payload_length = len(",".join(tokens))
        prefix = "^D%03d" % (payload_length + 3) + ",".join(tokens[:GS_AC_OUTPUT_FREQUENCY_INDEX]) + ","
        prefix_crc = crc16_xmodem(prefix.encode("latin1"))
        for frequency in range(4990, 5011):
            for component_temperature in range(151):
                for external_temperature in range(151):
                    candidate = list(tokens)
                    candidate[GS_AC_OUTPUT_FREQUENCY_INDEX] = "%04d" % frequency
                    candidate[22] = "%03d" % component_temperature
                    candidate[23] = "%03d" % external_temperature
                    tail = ",".join(candidate[GS_AC_OUTPUT_FREQUENCY_INDEX:]).encode("latin1")
                    if crc16_xmodem_continued(prefix_crc, tail) in MIXED_CRCS:
                        return data_frame(",".join(candidate))
        raise RuntimeError("no GS variant has a mixed CRC")

    def ps_frame(self):
        serial = self.next_serial()
        tokens = list(PS_TOKENS)
        tokens[PS_SOLAR_POWER_2_INDEX] = "%05d" % serial
        if self.fault_14_latched:
            tokens[PS_BATTERY_DIRECTION_INDEX] = "0"
            tokens[PS_DC_AC_DIRECTION_INDEX] = "0"
        return data_frame(",".join(tokens)), serial

    def status_frame(self, command):
        """MOD/CFS/WS answer with data, HFS0n with slot n's record (None = no record: send a NAK)"""
        if command == "MOD":
            return data_frame(MOD_FAULT if self.fault_14_latched else MOD_HYBRID)
        if command == "CFS":
            return data_frame(CFS_AFTER_LATCH if self.fault_14_latched else CFS_BEFORE_LATCH)
        if command == "WS":
            return data_frame(WS_ALL_CLEAR)
        slot = int(command[4])
        return data_frame(HFS_RECORDS[slot]) if slot < len(HFS_RECORDS) else None

    def settings_frame(self, command):
        if command == "GPMP":
            return data_frame("%05d" % self.gpmp), None
        if command == "HECS":
            return data_frame(",".join(self.hecs_tokens)), None
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
        if self.commit_needs_quiet_s and self.pending_commits:
            # Any traffic restarts the quiet period a starved commit is waiting for
            self.commits_deferred_by_traffic += len(self.pending_commits)
            self.pending_commits = [
                (max(apply_at, now + self.commit_needs_quiet_s), description, apply_fn)
                for apply_at, description, apply_fn in self.pending_commits
            ]
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
            if count == 13 and "gs13" in self.faults_remaining:
                self.fault_done("gs13")
                frame, serial = self.gs_frame(force_mixed_crc=True)
                self.queue(frame, "GS", "GS", "answer", serial)
                emit("crc_bumped_answer", serial=serial, crc=frame[-3:-1].hex())
                return
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
        elif command in ("MOD", "CFS", "WS") or (command.startswith("HFS0") and len(command) == 5):
            frame = self.status_frame(command)
            if frame is None:
                self.queue(NAK, "NAK", command, "declined", None)
                # A declined slot answers in a setter's shape: the engine must leave the line quiet after it
                self.next_command_follows_anomaly = True
            else:
                self.queue(frame, command, command, "answer", None)
        else:
            emit("unknown_query", command=command)

    def handle_setter(self, command):
        self.setters_seen += 1
        if command.startswith("EDF") and "edf_late" in self.faults_remaining:
            if self.held_first_edf is None:
                # First attempt: received and committed, but its ACK is held back
                self.held_first_edf = command
                self.schedule_commit(command)
                emit("setter_answer_held", answering=command)
                self.next_command_follows_anomaly = True
                return
            if command == self.held_first_edf:
                # The retry: the first attempt's late ACK now, the retry's own answer (a NAK) after it
                self.fault_done("edf_late")
                self.queue(ACK, "ACK", command, "answer", None)
                self.queue(NAK, "NAK", command, "duplicate", None, delay_s=0.15)
                self.next_command_follows_anomaly = True
                return
        if self.setters_seen == 1 and "setter1" in self.faults_remaining:
            self.fault_done("setter1")
            stale, stale_serial = self.ps_frame()
            self.queue(stale, "PS", command, "stale", stale_serial)
            self.next_command_follows_anomaly = True
        self.queue(ACK, "ACK", command, "answer", None)
        self.schedule_commit(command)

    def schedule_commit(self, command):
        apply_at = time.monotonic() + max(self.commit_delay_s, self.commit_needs_quiet_s)
        if command == "EDB0":
            self.pending_commits.append((apply_at, command, self.end_buy_window_into_fault_14))
        elif command.startswith("ED") and len(command) == 4:
            token_index = ord(command[2]) - ord("A") + 1
            value = command[3]
            self.pending_commits.append((apply_at, command, lambda: self.hecs_tokens.__setitem__(token_index, value)))
        elif command.startswith("GPMP0"):
            watts = int(command[5:])
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "gpmp", watts)))
        elif command.startswith("MCHGV"):
            bulk, floating = (int(value) for value in command[5:].split(","))
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "charge_voltage_tenths", (bulk, floating))))
        elif command.startswith("MUCHGC"):
            amps_tenths = int(command[6:])
            self.pending_commits.append((apply_at, command, lambda: setattr(self, "max_ac_charging_tenths", amps_tenths)))

    def end_buy_window_into_fault_14(self):
        self.hecs_tokens[2] = "0"
        self.fault_14_latched = True
        emit("fault_14_latched")

    def fault_done(self, fault):
        self.faults_remaining.discard(fault)
        emit("fault", fault=fault)
        if not self.faults_remaining:
            emit("faults_done")


def main():
    parser = argparse.ArgumentParser(description="Fake MPI 15K speaking PI17 on a pty")
    parser.add_argument("--commit-delay-s", type=float, default=COMMIT_DELAY_S)
    parser.add_argument("--commit-needs-quiet-s", type=float, default=0.0)
    parser.add_argument("--no-faults", action="store_true")
    arguments = parser.parse_args()
    master_fd, slave_fd = os.openpty()
    # Raw + no echo on the slave side so nothing we send is reflected back at us; keeping our own
    # slave fd open also stops master reads from failing with EIO before the session opens it.
    tty.setraw(slave_fd)
    inverter = FakeInverter(master_fd, arguments.commit_delay_s, arguments.commit_needs_quiet_s, not arguments.no_faults)
    emit("ready", device=os.ttyname(slave_fd))
    received = b""
    while True:
        wakeup = inverter.next_wakeup()
        timeout = 0.05 if wakeup is None else max(0.0, min(0.05, wakeup - time.monotonic()))
        readable, _, _ = select.select([master_fd, sys.stdin], [], [], timeout)
        if sys.stdin in readable and not sys.stdin.buffer.read1(1024):
            emit(
                "summary",
                overlaps=inverter.overlaps,
                counts=inverter.counts,
                faults_remaining=sorted(inverter.faults_remaining),
                pending_commits=[description for _, description, _ in inverter.pending_commits],
                commits_deferred_by_traffic=inverter.commits_deferred_by_traffic,
            )
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
