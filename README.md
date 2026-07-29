# mpico_extended

> [!IMPORTANT]
> ## Built on [mai_pico](https://github.com/whowechina/mai_pico) by whowechina
>
> The original firmware, the board design and the electronics are **their
> work**. This repository would not exist without it, and everything good here
> starts from what they built.
>
> ### ⭐ [Go star the original project](https://github.com/whowechina/mai_pico)
>
> This is **not** official, **not** a fork and **not** affiliated: it is a
> modified version, published under GPL-3.0 as the original licence requires.
> Base: [`e21fa23`](https://github.com/whowechina/mai_pico/commit/e21fa23) of
> `firmware/`, 27 August 2025.

An alternative firmware for **full-size** maimai-style controllers, with a web
monitor to calibrate and debug a panel from the browser instead of from a blind
serial console.

### → [Open the monitor](https://ouarss.github.io/mpico_extended/)

Chrome or Edge, nothing to install. Without a board connected it still opens,
so you can read the documentation and see what the tool does before flashing
anything.

> [!NOTE]
> **Personal note, so you know what you are getting.** This project has been
> heavily vibecoded. I understand the broad strokes of how it works, but not the
> fine details, so I may not be able to take it much further.
>
> I built it for myself and never planned to release it. I know what a hassle
> setting up a full ITO panel can be, and the results on mine are genuinely
> great: not a single misfire, and it reacts perfectly. That said, I am no pro.
>
> It may not work flawlessly for everyone. But it is heavily customisable, and
> at the very least you can use it to track down your own issues.

![The Live view: the playfield, every zone's delta over time, and the last real
triggers](docs/media/live.png)

*Live view: what the board feels right now, zone by zone. A line drifting up
while nothing is touched is a zone picking up noise.*

## Why a separate project

mai_pico targets a compact, reduced-size controller.

We work here with a full-size DIY playfield, and that changes the physics:
bigger electrodes mean more surface, more parasitic capacitance, more crosstalk
between neighbours, and a signal several times weaker.

The stock firmware lets the MPR121 chip decide whether a zone is touched. That
suits small electrodes, but leaves too little control once the panel grows.

**This firmware moves the touch decision into the software.** It reads each
electrode's filtered value and its resting reference, then compares the delta
against that zone's own threshold, with hysteresis, averaging and debounce.

The decision is then a plain comparison on that delta:

```text
delta
   85            .------.
                 |      |
   40 --------- ON ------------- threshold ON: zone fires at 40
   30 ----------|------ OFF ---- threshold OFF: 40 x (1 - 25% hyst) = 30
    0 __________'        '______
        rest     press    release
```

Two things are easily confused, so to be explicit:

| Question | Answer |
|---|---|
| **Who decides** a zone is touched | Always the firmware. No switch back. |
| **Who tracks the resting reference** | A setting: the MPR121 by default, or the firmware at its own rate. Frozen while a zone is held either way. |

Because it changes such a core behaviour, this could not simply be merged
upstream, hence a separate repository rather than a pull request.

## The web monitor

**The part that makes a full-size panel possible to set up at all.** Tuning one
through a serial console means typing thresholds blind and guessing why a zone
misfires; this replaces that with something you can see and measure while the
board runs.

| Tab | What it does |
|---|---|
| **Live** | The board's current state, zone by zone, with traces, live threshold edits and the last real triggers. The place to debug anything. |
| **Auto Calibration** | A guided 5-step wizard: measures the noise floor, then press strength per zone, computes every threshold, verifies over 60 s, saves. |
| **Live Calibration** | Watches you play, spots near-misses (clean gestures that failed to trigger), suggests per-zone corrections. Experimental. |
| **Tuning** | Every setting, per zone, applied live, each with its own explanation. |
| **Mapping** | Which electrode feeds which zone, remappable by touching the panel. |
| **Logs** | Per-zone peak, noise ceiling and trigger counts, session recording, auto-save to disk as CSV/JSON. |
| **Profiles** | Named snapshots of the whole setup, exportable and importable. |
| **Console** | Raw CLI access for everything else. |

It runs at **[ouarss.github.io/mpico_extended](https://ouarss.github.io/mpico_extended/)**,
or straight from `monitor/index.html` in a local checkout. Both work the same;
the online one also gets the log auto-save, which a `file://` page cannot use.

It is original work, not derived from the upstream code, and talks to the board
over **WebSerial** (so: Chrome or Edge). Nothing is uploaded anywhere. No
account, no server, no telemetry: the page is served as static files and talks
only to your serial port.

Its **Information tab is the real documentation**: eleven articles covering the
hardware, how detection works, fighting false triggers, both calibration modes,
the logs, the profiles and the serial protocol. It sits next to the settings it
explains, with live values in view, which is why it is not duplicated here.

![The Tuning tab: signal processing settings and per-zone thresholds](docs/media/tuning.png)

*Tuning: every knob of the software decision, each with its own explanation, and
per-zone thresholds whose bars fill as the live delta approaches them.*

### Auto-calibration, step by step

The wizard is the reason a full-size panel becomes workable in minutes. Getting
there without one took months: change a threshold, play a round, watch a zone
fire on its own anyway, change something else, and never actually see what the
panel was doing. No way to tell a noisy electrode from a badly mapped one from a
threshold set too low.

That is the problem this was built to end. It measures, decides, then proves the
result.

![Step 1: the board is reset, the standby noise measured, and parameters
auto-tuned](docs/media/auto-calibration-1-noise.png)

*Step 1 resets the board and settles the **global** settings: it analyses the
standby noise, tries parameter combinations, and keeps the one that measurably
lowers it. That baseline is what the next steps fine-tune zone by zone, and the
log shows it deciding: "max 17; clearly quieter - keeping avg 3".*

![Step 2: tap each zone while the wizard records the real press
peaks](docs/media/auto-calibration-2-press.png)

*Step 2 asks for a few taps per zone and counts **real presses**, not a timer.
If it detects the response on a different zone, you can remap that zone on the
fly, without leaving the wizard.*

![Step 4: a 60-second untouched watch that counts any zone firing on its
own](docs/media/auto-calibration-4-verify.png)

*Step 4 applies the computed thresholds, then watches an untouched panel for a
full minute and counts every zone that fires by itself. Any false trigger raises
that zone and re-runs the pass, until it comes back clean.*

## Firmware changes

| Area | Change |
|---|---|
| Touch decision | Made in firmware from the filtered/baseline delta, not by the MPR121 comparator |
| Tuning | Absolute per-zone thresholds, hysteresis, moving average, debounce, gain, filter, baseline mode |
| I2C | Round-robin sensor reads, bounded timeouts, core0 kept at 1 kHz |
| CLI | `thr`, `hyst`, `avg`, `debounce`, `gain`, `baseline`, `rebase`, `preset`, richer `raw` |
| Machine stream | `feed` publishes live frames and the full configuration as JSON, which is what the monitor consumes |
| LEDs | Button-to-LED chain order is remappable |
| Fixes | Flash write no longer hardfaults via core1 XIP, USB/HID bounds checks, CLI prefix matching |

The `upstream-base` branch holds the unmodified upstream `firmware/` at the base
commit, so the exact scope is one command away:

```sh
git diff upstream-base..main
```

Line endings there were normalised to LF to match this repository, so the diff
shows real changes only.

## Building

Requirements:

- a Unix shell (WSL or MSYS2/Git Bash), since the CMake build calls `cp` and `touch`
- [Pico SDK](https://github.com/raspberrypi/pico-sdk), via `PICO_SDK_PATH`
- `arm-none-eabi-gcc`, `cmake`, and `ninja` or `make`
- a host compiler (gcc/clang/cl) to build `pioasm` and `picotool`

`aic_pico` is **not** vendored here, fetch it at the pinned revision:

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
`RPI-RP2` drive that appears. Coming from another firmware? Run `factory` once
in the CLI, then open the
[monitor](https://ouarss.github.io/mpico_extended/) and run the
auto-calibration wizard: thresholds are specific to your panel and do not carry
over from someone else's.

Prebuilt binaries are attached to the
[releases](https://github.com/ouarss/mpico_extended/releases).

The USB vendor and product ids are deliberately unchanged (`0ca3`/`0021`), since
the game and existing tools identify the board by them. Product and interface
names do carry this firmware's identity, so a board running it is never mistaken
for a stock one.

## Licences

| Part | Licence |
|---|---|
| This firmware and the upstream code it derives from (`src/`) | **GPL-3.0**, see `LICENSE` |
| `monitor/` (original work) | GPL-3.0, as part of this repository |
| `aic_pico`, linked at build time | CC BY-NC 4.0, upstream |
| Upstream hardware (PCB, CAD, docs), **not** used here | CC BY-NC 4.0, upstream |

Two points worth stating plainly:

- **The firmware side is GPL.** Upstream licenses its `firmware/` under GPL-3.0
  and its hardware under CC BY-NC 4.0. This repository only derives from the
  firmware, so GPL-3.0 applies and the source is published here as required.
- **`aic_pico` is not.** It carries no separate licence for its firmware
  directory, so its root CC BY-NC 4.0 applies, which is not GPL-compatible. That
  inconsistency is upstream's and cannot be resolved here, so treat the built
  binary as **non-commercial**: do not sell it, or anything built from it.

Nobody involved is making money from this, and nobody should.

## Please don't send this project's support upstream

whowechina maintains mai_pico. They did not write the changes in this
repository, are not responsible for how it behaves, and their time should go to
their own project rather than to a version they never asked for.

So: anything about **this** firmware or the monitor, open it here. Questions
about the original firmware, the PCB or the hardware belong upstream, where they
will be answered far better than here.
