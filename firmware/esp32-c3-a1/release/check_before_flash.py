#!/usr/bin/env python3
"""Read-only compatibility check for the fixed ESP32-C3 InkSight A1 app0 image.

Only existing regular files are opened, in binary read mode. No device, serial,
network, subprocess, flashing, or file-writing operations are implemented.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import stat
import struct
import sys


FLASH_SIZE = 0x400000
APP_OFFSET = 0x10000
APP_SIZE = 0x1E0000
FIRMWARE_NAME = "miaomo-c3-a1-20261024.app.bin"
FIRMWARE_SIZE = 1202896
FIRMWARE_SHA256 = "befb5bd8e02547f2ab21f36272e75e9b613e1a6f1c60130c6756bf1529023c10"
BASELINE_SIZE = 1200880
BASELINE_SHA256 = "52a4c30da2dc0aec87da317d5a0cd22895535c1dfdbad43c48a8f32584a01af0"
APP0_OTA_SHA256 = "f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0"
EXPECTED_PARTITIONS = {
    "nvs": (1, 2, 0x9000, 0x5000),
    "otadata": (1, 0, 0xE000, 0x2000),
    "app0": (0, 0x10, APP_OFFSET, APP_SIZE),
    "app1": (0, 0x11, 0x1F0000, 0x1E0000),
    "spiffs": (1, 0x82, 0x3D0000, 0x20000),
    "coredump": (1, 3, 0x3F0000, 0x10000),
}


class CheckFailure(ValueError):
    """An input does not satisfy the narrowly supported release contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_regular_file(path: Path, size: int, description: str) -> bytes:
    require(stat.S_ISREG(path.stat().st_mode), f"{description}: regular file required")
    with path.open("rb") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode), f"{description}: regular file required")
        require(info.st_size == size, f"{description}: expected exactly {size} bytes")
        data = source.read(size + 1)
    require(len(data) == size, f"{description}: truncated or changed while reading")
    return data


def check_esp_image(data: bytes, description: str) -> int:
    """Validate the C3 24-byte header, bounded segments, XOR and optional SHA256.

    ESP32-C3 uses chip ID 5 and a bootloader at flash offset 0. The ESP image
    checksum occupies byte 15 of the final 16-byte aligned image block.
    """
    require(len(data) >= 24, f"{description}: truncated ESP image header")
    require(data[0] == 0xE9, f"{description}: ESP image magic missing")
    require(1 <= data[1] <= 16, f"{description}: invalid segment count")
    require(data[2] <= 3, f"{description}: invalid SPI flash mode")
    require(data[3] >> 4 == 2, f"{description}: header must declare 4 MiB flash")
    require(struct.unpack_from("<H", data, 12)[0] == 5,
            f"{description}: image is not ESP32-C3 (chip ID 5)")
    require(data[23] in (0, 1), f"{description}: invalid appended-hash flag")
    position = 24
    checksum = 0xEF
    for _ in range(data[1]):
        require(position + 8 <= len(data), f"{description}: truncated segment header")
        length = struct.unpack_from("<I", data, position + 4)[0]
        position += 8
        require(length <= len(data) - position, f"{description}: segment exceeds image bounds")
        for value in data[position:position + length]:
            checksum ^= value
        position += length
    checksum_at = position + (15 - position % 16)
    require(checksum_at < len(data), f"{description}: truncated checksum block")
    require(data[checksum_at] == checksum, f"{description}: image XOR checksum mismatch")
    end = checksum_at + 1
    if data[23] == 1:
        require(end + 32 <= len(data), f"{description}: truncated SHA256 digest")
        require(hashlib.sha256(data[:end]).digest() == data[end:end + 32],
                f"{description}: image SHA256 digest mismatch")
        end += 32
    return end


def check_partitions(table: bytes) -> None:
    require(len(table) == 0x1000, "partition table: truncated sector")
    entries: dict[str, tuple[int, int, int, int]] = {}
    ranges: list[tuple[int, int]] = []
    digest_at = None
    for position in range(0, len(table), 32):
        record = table[position:position + 32]
        if record[:2] == b"\xEB\xEB":
            require(record[2:16] == b"\xFF" * 14, "partition table: malformed MD5 record")
            require(hashlib.md5(table[:position], usedforsecurity=False).digest() == record[16:],
                    "partition table: MD5 mismatch")
            digest_at = position
            require(table[position + 32:] == b"\xFF" * (len(table) - position - 32),
                    "partition table: non-erased records after MD5")
            break
        require(record[:2] == b"\xAA\x50", "partition table: missing entry or MD5 record")
        _, kind, subtype, offset, size, raw_label, flags = struct.unpack("<HBBII16sI", record)
        try:
            label = raw_label.split(b"\x00", 1)[0].decode("ascii")
        except UnicodeDecodeError as error:
            raise CheckFailure("partition table: invalid ASCII label") from error
        require(bool(label) and len(label) < 16, "partition table: invalid label length")
        require(raw_label == label.encode("ascii").ljust(16, b"\x00"),
                "partition table: invalid label padding")
        require(label not in entries, "partition table: duplicate label")
        require(flags == 0, "partition table: encrypted or unknown flags are unsupported")
        require(size > 0 and offset >= 0x9000 and offset + size <= FLASH_SIZE,
                "partition table: partition exceeds flash bounds")
        require(offset % 0x1000 == 0 and size % 0x1000 == 0,
                "partition table: partition is not sector aligned")
        entries[label] = (kind, subtype, offset, size)
        ranges.append((offset, offset + size))
    require(digest_at is not None, "partition table: MD5 record missing")
    ordered = sorted(ranges)
    require(all(left[1] <= right[0] for left, right in zip(ordered, ordered[1:])),
            "partition table: overlapping partitions")
    require(entries == EXPECTED_PARTITIONS, "partition table: unsupported layout; exact six-partition layout required")


def check_backup(backup: bytes) -> str:
    require(len(backup) == FLASH_SIZE, "backup: exactly 4 MiB full-flash backup required")
    check_esp_image(backup[:0x8000], "bootloader at 0x0")
    check_partitions(backup[0x8000:0x9000])
    require(sha256(backup[0xE000:0x10000]) == APP0_OTA_SHA256,
            "OTA: unknown state; only the release-verified app0 OTA hash is accepted (all-FF is unsupported)")
    app = backup[APP_OFFSET:APP_OFFSET + APP_SIZE]
    if sha256(app[:FIRMWARE_SIZE]) == FIRMWARE_SHA256:
        require(check_esp_image(app, "existing app0") == FIRMWARE_SIZE,
                "existing app0: repaired image length mismatch")
        return "already-installed"
    require(sha256(app[:BASELINE_SIZE]) == BASELINE_SHA256,
            "existing app0: unknown baseline; this package only supports the verified original or repaired image")
    require(check_esp_image(app, "existing app0") == BASELINE_SIZE,
            "existing app0: original image length mismatch")
    return "verified-original"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--backup", type=Path, default=Path("full-backup.bin"),
                        help="existing unencrypted 4 MiB full-flash backup (default: full-backup.bin)")
    parser.add_argument("--firmware", type=Path,
                        default=Path(__file__).resolve().with_name(FIRMWARE_NAME),
                        help=f"fixed release app image (default: beside this script, {FIRMWARE_NAME})")
    args = parser.parse_args(argv)
    try:
        firmware = read_regular_file(args.firmware, FIRMWARE_SIZE, "firmware")
        require(sha256(firmware) == FIRMWARE_SHA256, "firmware: release SHA256 mismatch")
        require(check_esp_image(firmware, "firmware") == FIRMWARE_SIZE,
                "firmware: unexpected trailing data or image length")
        backup = read_regular_file(args.backup, FLASH_SIZE, "backup")
        state = check_backup(backup)
    except FileNotFoundError:
        print("FAIL: input file not found; provide existing backup and firmware files", file=sys.stderr)
        return 2
    except PermissionError:
        print("FAIL: input file is not readable", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"FAIL: input file I/O error ({error.errno})", file=sys.stderr)
        return 2
    except (CheckFailure, struct.error) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 2
    print("PASS: offline file compatibility checks passed; ESP32-C3, 4 MiB, exact InkSight app0 layout.")
    print("OTA: matched the release-verified app0 data hash; other OTA states are unsupported.")
    if state == "already-installed":
        print("RESULT: repaired firmware is already in app0; no repeat flash is needed.")
    else:
        print("RESULT: verified original app0; this app image is compatible only at offset 0x10000.")
    print("SCOPE: file checks only; no device was opened or written; A1 panel wiring is not detectable from a backup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
