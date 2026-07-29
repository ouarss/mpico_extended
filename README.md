# mpico_extended

> ## Built on [mai_pico](https://github.com/whowechina/mai_pico) by whowechina
>
> Every bit of the original firmware, the board design and the electronics is
> **whowechina's work**. This repository would not exist without it, and the
> credit for the foundation belongs there. Please go star the original project.
>
> This is **not** an official release, **not** a fork, and **not** affiliated
> with that project in any way. It is a modified version, published under
> **GPL-3.0** as the licence of the original firmware requires.
>
> Base: commit [`e21fa23`](https://github.com/whowechina/mai_pico/commit/e21fa23)
> of `firmware/`, 27 August 2025.

An alternative firmware for the mai_pico project, dedicated to **full-size
controllers**, together with a web-based tuning and diagnostics tool.

## Why a separate project

mai_pico targets a compact, reduced-size controller. On a full-size DIY
playfield the touch electrodes are physically much larger: more surface, more
parasitic capacitance, more crosstalk between neighbours, and a signal that is
several times weaker than on a small panel.

The stock firmware asks the MPR121 chip itself to decide whether a zone is
touched. That decision is a good fit for small electrodes, but it offers too
little control once the panel grows.

**This firmware moves the touch decision into the software.** The MPR121 is used
purely as a measuring front end, and the firmware compares each electrode's
delta against its own per-zone threshold, with hysteresis, averaging and
debounce. That is what makes a full-size panel tunable at all, and it is a
deliberate one-way change: there is no switch back to the hardware decision.

Because it changes such a core behaviour, it is not something that could simply
be merged upstream, hence a separate repository rather than a pull request.

## What is different

| Area | Change |
|---|---|
| Touch decision | Made in firmware from the filtered/baseline delta, not by the MPR121 comparator |
| Tuning | Absolute per-zone thresholds, hysteresis, moving average, debounce, gain, filter, baseline mode |
| I2C | Round-robin sensor reads, bounded timeouts, core0 kept at 1 kHz |
| CLI | `thr`, `hyst`, `avg`, `debounce`, `gain`, `baseline`, `rebase`, `preset`, richer `raw` |
| Machine stream | `feed` publishes live frames and the full configuration as JSON |
| LEDs | Button-to-LED chain order is remappable |
| Web monitor | New: live view, tuning, mapping, auto-calibration, live calibration, logs, profiles |
| Fixes | Flash write no longer hardfaults via core1 XIP, USB/HID bounds checks, CLI prefix matching |

For the exact scope, the `upstream-base` branch holds the unmodified upstream
`firmware/` directory at the base commit:

```sh
git diff upstream-base..master
```

Line endings on that branch were normalised to LF to match this repository, so
the diff shows real changes only.

## The monitor

`monitor/` is an original web tool, not derived from the upstream code. It talks
to the board over **WebSerial**, so it needs Chrome or Edge and an HTTPS page (or
a local file). Nothing is uploaded anywhere: the page talks to the serial port
and to nothing else.

It covers live signal inspection, per-zone tuning, electrode mapping, a guided
auto-calibration, threshold tuning while playing, session logs and configuration
profiles.

## Building

Requirements:

- a Unix shell (WSL or MSYS2/Git Bash), since the CMake build calls `cp` and `touch`
- [Pico SDK](https://github.com/raspberrypi/pico-sdk), via `PICO_SDK_PATH`
- `arm-none-eabi-gcc`, `cmake`, and `ninja` or `make`
- a host compiler (gcc/clang/cl) to build `pioasm` and `picotool`

The firmware links against `aic_pico`, which is **not** vendored here. Fetch it
at the pinned revision:

```sh
git clone https://github.com/whowechina/aic_pico modules/aic_pico
git -C modules/aic_pico checkout 5a0dbc9d132218c67f2a3b500e4251c96fcaf2df
```

Then:

```sh
export PICO_SDK_PATH=$HOME/pico/pico-sdk
./build.sh
```

The result is `mpico_extended.uf2` at the repository root.

## Flashing

Hold **BOOTSEL** while plugging the USB cable, then drop the `.uf2` on the
`RPI-RP2` drive that appears. After flashing a board that was already
configured, run `factory` once in the CLI.

Prebuilt binaries are attached to the
[releases](https://github.com/ouarss/mpico_extended/releases).

The USB vendor and product ids are deliberately left unchanged (`0ca3`/`0021`),
because the game and the existing tools identify the board by them. The product
and interface names, however, carry this firmware's own identity, so a board
running it is never mistaken for a stock one.

## Licences

| Part | Licence |
|---|---|
| This firmware and the upstream code it derives from (`src/`) | **GPL-3.0** (see `LICENSE`) |
| `monitor/` (original work) | GPL-3.0, as part of this repository |
| `aic_pico`, linked at build time | CC BY-NC 4.0, upstream |
| Upstream hardware (PCB, CAD, docs), **not** used here | CC BY-NC 4.0, upstream |

Two things worth stating plainly:

- The upstream project licenses its `firmware/` directory under GPL-3.0 and its
  hardware under CC BY-NC 4.0. This repository only derives from the firmware,
  so GPL-3.0 applies, and the source is published here as that licence requires.
- `aic_pico` carries no separate licence for its firmware directory, so the
  CC BY-NC 4.0 of its root applies. That is not compatible with the GPL. The
  inconsistency is upstream's and cannot be resolved here, so treat the built
  binary as **non-commercial**: do not sell it, or anything built from it.

Nobody involved is making money from this, and nobody should.

## Not a support channel for mai_pico

Questions, bugs or hardware issues concerning the original project belong to the
original project, not here. Please do not open issues there about this fork's
behaviour either: the changes in this repository are not theirs to maintain.
