#!/usr/bin/env python3
"""
bin2uf2 - Convert a raw RP2040 binary (.bin) into a flashable UF2 image.

Standalone replacement for `picotool uf2 convert` when that one crashes in the
build environment (segfault during the ELF->UF2 conversion). The .bin produced
by objcopy is loaded at the RP2040 flash base address.

Usage:
    python bin2uf2.py <input.bin> <output.uf2> [base_address_hex]

Default base address: 0x10000000 (start of the RP2040 XIP flash).
"""

import sys
import struct

# UF2 format constants (see Microsoft/uf2 and pico-sdk boot/uf2.h)
UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_ID = 0x00002000
RP2040_FAMILY_ID = 0xE48BFF56
PAYLOAD_SIZE = 256  # useful bytes per UF2 block


def convert(bin_path: str, uf2_path: str, base_addr: int) -> int:
    with open(bin_path, "rb") as f:
        data = f.read()

    num_blocks = (len(data) + PAYLOAD_SIZE - 1) // PAYLOAD_SIZE
    with open(uf2_path, "wb") as out:
        for block in range(num_blocks):
            chunk = data[block * PAYLOAD_SIZE:(block + 1) * PAYLOAD_SIZE]
            addr = base_addr + block * PAYLOAD_SIZE
            payload = chunk + b"\x00" * (476 - len(chunk))
            out.write(struct.pack(
                "<IIIIIIII",
                UF2_MAGIC_START0,
                UF2_MAGIC_START1,
                UF2_FLAG_FAMILY_ID,
                addr,
                PAYLOAD_SIZE,
                block,
                num_blocks,
                RP2040_FAMILY_ID,
            ))
            out.write(payload)
            out.write(struct.pack("<I", UF2_MAGIC_END))

    return num_blocks


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    bin_path = sys.argv[1]
    uf2_path = sys.argv[2]
    base_addr = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x10000000

    blocks = convert(bin_path, uf2_path, base_addr)
    print(f"OK: {uf2_path} ({blocks} blocks, base 0x{base_addr:08x})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
