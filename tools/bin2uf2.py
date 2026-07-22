#!/usr/bin/env python3
"""
bin2uf2 - Convertit un binaire brut RP2040 (.bin) en image UF2 flashable.

Remplacant autonome de `picotool uf2 convert` quand ce dernier plante dans
l'environnement de build (segfault a la conversion ELF->UF2). Le .bin genere
par objcopy est charge a l'adresse de base de la flash RP2040.

Usage :
    python bin2uf2.py <entree.bin> <sortie.uf2> [adresse_base_hex]

Adresse de base par defaut : 0x10000000 (debut de la flash XIP RP2040).
"""

import sys
import struct

# Constantes du format UF2 (voir Microsoft/uf2 et pico-sdk boot/uf2.h)
UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END = 0x0AB16F30
UF2_FLAG_FAMILY_ID = 0x00002000
RP2040_FAMILY_ID = 0xE48BFF56
PAYLOAD_SIZE = 256  # octets utiles par bloc UF2


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
    print(f"OK : {uf2_path} ({blocks} blocs, base 0x{base_addr:08x})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
